// Key custody for `setup` (docs/deployment.md §5.1). GitHub shows an App's
// private key once, when it is generated, so a key is written to disk the
// moment it arrives and never held only in memory:
//   - `--keys-dir <dir>`: `<dir>/<slug>.pem` (mode 0600, created exclusively,
//     never overwritten) and `<dir>/apps.json` (ids, client ids, slugs and
//     installation ids: nothing secret). The directory must be outside any
//     git work tree and closed to group and others.
//   - `--key-cmd '<command>'`: each key is read from the operator's secure
//     store by running `<command> <slug>`; nothing is written.
// apps.json is a convenience record only: every value in it is read back
// from GitHub on each run, so losing it loses nothing.

import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Role } from "./expected";

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

export interface AppRecord {
  slug: string;
  id: number;
  clientId: string;
  installationId?: number;
}

export type AppsFile = Partial<Record<Role, AppRecord>>;

/** Where keys come from. `canStore` is false for a key command: it can read keys, never keep a new one. */
export interface KeyStore {
  readonly describe: string;
  readonly canStore: boolean;
  /** The key for an App, or null when there is none yet. */
  read(slug: string): string | null;
  /** Keep a newly generated key. Refuses to replace an existing one. */
  store(slug: string, pem: string): void;
  /** Where the operator should put a replacement key (a key-dir path), or null. */
  pathFor(slug: string): string | null;
  apps(): AppsFile;
  saveApps(apps: AppsFile): void;
}

/** `p` with every existing part resolved through symlinks (the rest appended as given). */
function canonical(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(canonical(parent), abs.slice(parent.length).replace(/^\//, ""));
}

/** The nearest enclosing git work tree of `dir`, or null (symlinks followed, as the writes will). */
export function gitWorkTree(dir: string): string | null {
  for (let d = canonical(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

function checkSlug(slug: string): void {
  if (!SLUG.test(slug)) throw new KeyError(`refusing an unexpected App slug ${JSON.stringify(slug)}`);
}

export class DirKeyStore implements KeyStore {
  readonly canStore = true;
  readonly dir: string;

  /** `create`: make a missing directory (mode 0700); a plan only reads, and treats a missing one as empty. */
  constructor(dir: string, create = true) {
    this.dir = canonical(dir);
    const repo = gitWorkTree(this.dir);
    if (repo) throw new KeyError(`--keys-dir ${this.dir} is inside the git work tree ${repo}: keep App keys outside every repository`);
    if (!existsSync(this.dir)) {
      if (!create) return;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
    const st = statSync(this.dir);
    if (!st.isDirectory()) throw new KeyError(`--keys-dir ${this.dir} is not a directory`);
    if (st.mode & 0o077) throw new KeyError(`--keys-dir ${this.dir} is readable by group or others (mode ${(st.mode & 0o777).toString(8)}): run chmod 700 ${this.dir}`);
  }

  get describe(): string {
    return this.dir;
  }

  pathFor(slug: string): string {
    checkSlug(slug);
    return join(this.dir, `${slug}.pem`);
  }

  read(slug: string): string | null {
    const p = this.pathFor(slug);
    if (!existsSync(p)) return null;
    if (lstatSync(p).isSymbolicLink()) throw new KeyError(`${p} is a symlink: put the key file itself in the directory`);
    const st = statSync(p);
    if (st.mode & 0o077) {
      // A key downloaded from the App settings page arrives with the umask's mode.
      chmodSync(p, 0o600);
    }
    const pem = readFileSync(p, "utf8");
    if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) throw new KeyError(`${p} is not a PEM private key`);
    return pem;
  }

  store(slug: string, pem: string): void {
    const p = this.pathFor(slug);
    let fd: number;
    try {
      fd = openSync(p, "wx", 0o600);
    } catch (e) {
      throw new KeyError(`refusing to overwrite ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      writeSync(fd, pem);
    } finally {
      closeSync(fd);
    }
  }

  apps(): AppsFile {
    const p = join(this.dir, "apps.json");
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, "utf8")) as AppsFile;
    } catch {
      return {};
    }
  }

  saveApps(apps: AppsFile): void {
    const p = join(this.dir, "apps.json");
    const tmp = `${p}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(apps, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  }
}

/** Keys from the operator's secure store: `<command> <slug>` prints the PEM. */
export class CommandKeyStore implements KeyStore {
  readonly canStore = false;
  private record: AppsFile = {};

  constructor(private readonly command: string) {
    if (!command.trim()) throw new KeyError("--key-cmd needs a command");
  }

  get describe(): string {
    return `the key command (${this.command} <slug>)`;
  }

  pathFor(): null {
    return null;
  }

  read(slug: string): string | null {
    checkSlug(slug);
    const r = spawnSync("sh", ["-c", `${this.command} "$1"`, "sh", slug], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) return null;
    return /-----BEGIN (RSA )?PRIVATE KEY-----/.test(r.stdout) ? r.stdout : null;
  }

  store(slug: string): void {
    throw new KeyError(`cannot keep a new key for ${slug} with --key-cmd: use --keys-dir for the apps step, then move the keys into your store`);
  }

  apps(): AppsFile {
    return this.record;
  }

  saveApps(apps: AppsFile): void {
    this.record = apps;
  }
}
