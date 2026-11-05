// A stand-in for the `gh` CLI in the cross-process setup test: it answers
// `gh auth token` and `gh secret set <name> --env <env> --repo <owner/name>`
// (value on stdin) against the fake GitHub at QLANDER_GITHUB_API, which
// takes the value in clear where the real API takes a sealed box.

const [cmd, sub, ...rest] = process.argv.slice(2);
const arg = (flag: string) => rest[rest.indexOf(flag) + 1];

if (cmd === "auth" && sub === "token") {
  console.log(process.env.GH_TOKEN ?? "");
  process.exit(process.env.GH_TOKEN ? 0 : 1);
}
if (cmd === "secret" && sub === "set") {
  const value = await Bun.stdin.text();
  const res = await fetch(`${process.env.QLANDER_GITHUB_API}/repos/${arg("--repo")}/environments/${arg("--env")}/secrets/${rest[0]}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(res.ok ? 0 : 1);
}
console.error(`fake gh: unsupported command ${process.argv.slice(2).join(" ")}`);
process.exit(1);

export {};
