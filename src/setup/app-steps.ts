// The App steps of `setup` (docs/deployment.md §5.2, §5.3): `apps` creates
// the Apps through the manifest flow and checks each key and permission set,
// `install` waits for each App to be installed on its one repo, and
// `permissions` walks a person through a permission change, polling the
// registration first and then each installation.

import type { App, Installation } from "./client";
import type { Ctx, Manifest } from "./context";
import { type AppSpec, full, permissionDiff } from "./expected";
import type { KeyStore } from "./keys";
import { newAppLink } from "./manifest-flow";

const PERMISSION_TITLE: Record<string, string> = {
  actions: "Actions",
  checks: "Checks",
  contents: "Contents",
  metadata: "Metadata",
  pull_requests: "Pull requests",
  statuses: "Commit statuses",
  workflows: "Workflows",
};
const title = (p: string) => PERMISSION_TITLE[p] ?? p;
const levelTitle = (l: string) => (l === "none" ? "No access" : l === "read" ? "Read-only" : "Read and write");

export function manifestFor(c: Ctx, spec: AppSpec): Manifest {
  const n = c.d.config.config.names;
  const home = `${c.d.web}/${n.control.owner}/${n.control.name}`;
  return { name: spec.name, url: home, hook_attributes: { url: home, active: false }, public: false, default_permissions: spec.permissions, default_events: [] };
}

export async function appsStep(c: Ctx): Promise<void> {
  for (const spec of c.specs) {
    let app = await c.d.api.app(spec.slug);
    if (!app) {
      if (!c.d.apply) {
        c.d.out(`plan  create the ${spec.role} App ${spec.name} on ${spec.owner} (manifest flow; an owner clicks Create)`);
        continue;
      }
      const keys = c.d.keys;
      if (!keys?.canStore) c.fail(`creating ${spec.name} needs --keys-dir: GitHub shows a new App's key only once`);
      const code = await waitForCreate(c, spec, keys);
      if (code === null) {
        app = await c.existing(spec);
        c.d.out(`done  found the ${spec.role} App ${app.slug} (id ${app.id}), made from the link, and its key`);
      } else {
        const conv = await c.d.api.convertManifest(code);
        // The key first, before anything else can fail: GitHub shows it only once. A key already there stays, and the check below decides if it is this App's.
        const kept = keys.read(conv.slug) !== null;
        if (!kept) keys.store(conv.slug, conv.pem);
        c.record(spec.role, { slug: conv.slug, id: conv.id, clientId: conv.clientId });
        c.d.out(kept ? `done  created the ${spec.role} App ${conv.slug} (id ${conv.id}); kept the key already in ${keys.describe}, and did not store the new one` : `done  created the ${spec.role} App ${conv.slug} (id ${conv.id}); its key is in ${keys.describe}`);
        if (conv.slug !== spec.slug) c.fail(`GitHub named the App ${conv.slug}, not ${spec.slug}: choose another --name, or rename it to ${spec.name}`);
        app = conv;
      }
    } else c.ok(`the ${spec.role} App ${spec.slug} exists (id ${app.id})`);
    if (app.owner.toLowerCase() !== spec.owner.toLowerCase()) c.fail(`${spec.slug} is owned by ${app.owner}, not ${spec.owner}: a private App installs only on its owner`);
    const pem = await keyFor(c, spec);
    if (pem === null) continue;
    const seen = await c.byKey(spec, app, pem);
    c.record(spec.role, { slug: app.slug, id: app.id, clientId: app.clientId });
    const diff = permissionDiff(seen.permissions, spec.permissions);
    if (diff.length) {
      for (const p of diff) c.d.out(`        ${title(p.name)}: has ${p.have}, needs ${p.want}`);
      c.fail(`${spec.slug}'s permissions differ from the expected set (DESIGN.md §12.1): run setup --step permissions`);
    }
    c.ok(`${spec.slug} has exactly its permissions`);
  }
}

/**
 * The manifest flow's code, or null once a person has made the App from the
 * link and saved its key. The App alone isn't enough: the manifest flow makes
 * one too, a moment before its code arrives, and only that code carries its key.
 */
async function waitForCreate(c: Ctx, spec: AppSpec, keys: KeyStore): Promise<string | null> {
  const manifest = manifestFor(c, spec);
  const where = keys.pathFor(spec.slug) ?? keys.describe;
  const stop = new AbortController();
  const flow = c.d.manifestCode(spec, manifest, stop.signal);
  c.d.out(`        GitHub's form empty? Use this link instead, and keep the name it fills in:`);
  c.d.out(`        ${newAppLink(c.d.web, spec.owner, manifest)}`);
  c.d.out(`        GitHub can drop a permission from a link, so check them before you click "Create GitHub App": ${Object.entries(spec.permissions).map(([p, l]) => `${title(p)}: ${levelTitle(l)}`).join(", ")}`);
  c.d.out(`        then on the App's page click Credentials in the left sidebar, then Key pairs, then New key, and save the download as ${where}`);
  c.d.out("        setup carries on by itself once GitHub shows the App and the key is there, or rerun it");
  let settled = false;
  void c
    .poll(`the ${spec.role} App ${spec.slug}`, async () => {
      if (settled) return [];
      try {
        const app = await c.d.api.app(spec.slug);
        if (settled) return [];
        if (!app) return ["not created yet"];
        return keys.read(spec.slug) ? [] : [`it exists; waiting for its code, or its key at ${where}`];
      } catch (e) {
        return [e instanceof Error ? e.message : String(e)];
      }
    })
    .then((found) => {
      if (found && !settled) stop.abort();
    });
  try {
    return await flow;
  } finally {
    settled = true;
  }
}

/**
 * The App's key from the store. A missing one is replaced, never recovered:
 * print where to generate it and, when applying, wait for it to appear.
 * Null in plan mode when there is none.
 */
async function keyFor(c: Ctx, spec: AppSpec): Promise<string | null> {
  const keys = c.d.keys;
  if (!keys) c.fail(`the ${spec.slug} key is needed: pass --keys-dir <dir> or --key-cmd <command>`);
  const pem = keys.read(spec.slug);
  if (pem) {
    c.ok(`the ${spec.slug} key is in ${keys.describe}`);
    return pem;
  }
  const where = keys.pathFor(spec.slug);
  c.todo([
    `${spec.slug} exists but its private key is not in ${keys.describe}. GitHub cannot show an existing key again, so generate a new one:`,
    `open ${c.appUrl(spec)}, click Credentials in the left sidebar, then Key pairs, then New key`,
    where ? `save the downloaded file as ${where}` : "put it in your key store",
    "then run setup --step control --rotate, and delete the old key on the same page",
  ]);
  if (!c.d.apply) return null;
  const found = await c.poll(`the ${spec.slug} key`, async () => (keys.read(spec.slug) ? [] : ["not there yet"]));
  if (!found) c.fail(`no key for ${spec.slug} appeared`);
  return keys.read(spec.slug)!;
}

export async function installStep(c: Ctx): Promise<void> {
  for (const spec of c.specs) {
    const found = await c.d.api.app(spec.slug);
    if (!found && !c.d.apply) {
      c.d.out(`plan  install ${spec.slug} on ${full(spec.repo)} only, once it exists`);
      continue;
    }
    const app = found ?? (await c.existing(spec));
    const first = await c.installProblems(spec, app);
    let inst: Installation | null = first.inst;
    if (first.problems.length) {
      c.todo([
        `install ${spec.slug} on ${full(spec.repo)} only ("Only select repositories"): ${first.problems.join("; ")}`,
        `open ${first.inst ? c.installationUrl(spec, first.inst.id) : `${c.d.web}/apps/${spec.slug}/installations/new`}`,
      ]);
      if (!c.d.apply) continue;
      const done = await c.poll(`${spec.slug}'s installation`, async () => {
        const r = await c.installProblems(spec, app);
        inst = r.inst;
        return r.problems;
      });
      if (!done) c.fail(`${spec.slug} is not installed on ${full(spec.repo)} alone`);
    }
    c.ok(`${spec.slug} is installed on ${full(spec.repo)} only (installation ${inst!.id})`);
    c.record(spec.role, { slug: app.slug, id: app.id, clientId: app.clientId, installationId: inst!.id });
  }
}

/** §5.3: a permission change is made by hand. Print the steps, poll the registration, then each installation. */
export async function permissionsStep(c: Ctx): Promise<void> {
  let pending = 0;
  for (const spec of c.specs) {
    const app = await c.existing(spec);
    if (!(await registration(c, spec, app))) {
      pending++;
      continue;
    }
    if (!(await installation(c, spec, app))) pending++;
  }
  if (pending) c.fail(`${pending} App(s) wait for a person to change or accept permissions`);
}

/** True once the registration permissions match. */
async function registration(c: Ctx, spec: AppSpec, app: App): Promise<boolean> {
  const diff = permissionDiff(app.permissions, spec.permissions);
  if (diff.length === 0) {
    c.ok(`${spec.slug}: registration permissions match`);
    return true;
  }
  c.todo([
    `${spec.slug}: the registration permissions differ. Open ${c.appUrl(spec, "/permissions")}:`,
    ...diff.map((p) => `set ${title(p.name)} to ${levelTitle(p.want)} under Repository permissions (now ${levelTitle(p.have)})`),
    'then click "Save changes" (Permissions & events)',
  ]);
  if (!c.d.apply) return false;
  const saved = await c.poll(`${spec.slug} registration`, async () => {
    const a = await c.d.api.app(spec.slug);
    return permissionDiff(a?.permissions ?? {}, spec.permissions).map((p) => `${p.name} is ${p.have}, needs ${p.want} (not saved)`);
  });
  if (!saved) c.fail(`${spec.slug}: the registration permissions were not saved`);
  c.ok(`${spec.slug}: registration permissions saved`);
  return true;
}

/** True once the App's installation has accepted the permissions. */
async function installation(c: Ctx, spec: AppSpec, app: App): Promise<boolean> {
  const inst = await c.installation(spec, app);
  if (!inst) {
    c.todo([`${spec.slug} is not installed: run setup --step install`]);
    return false;
  }
  const diff = permissionDiff(inst.permissions, spec.permissions);
  if (diff.length === 0) {
    c.ok(`${spec.slug}: installation ${inst.id} has accepted them`);
    return true;
  }
  c.todo([
    `${spec.slug}: installation ${inst.id} has not accepted the permissions (${diff.map((p) => `${p.name} ${p.have}→${p.want}`).join(", ")})`,
    `open ${c.installationUrl(spec, inst.id)} and accept the new permissions`,
  ]);
  if (!c.d.apply) return false;
  const accepted = await c.poll(`${spec.slug} installation ${inst.id}`, async () => {
    const i = await c.installation(spec, app);
    return permissionDiff(i?.permissions ?? {}, spec.permissions).map((p) => `${p.name} is ${p.have}, needs ${p.want} (saved, not accepted)`);
  });
  if (!accepted) c.fail(`${spec.slug}: installation ${inst.id} has not accepted the permissions`);
  c.ok(`${spec.slug}: installation ${inst.id} has accepted them`);
  return true;
}
