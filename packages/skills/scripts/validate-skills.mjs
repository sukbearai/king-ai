import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(packageRoot, "skills");

const requiredBodyMarkers = new Map([
  [
    "grok-cpa-bootstrap",
    [
      "Never commit or print API keys",
      "Require explicit user authorization and an exact count",
      "https://github.com/sukbearai/king-ai.git",
      "https://github.com/AaronL725/grok-register.git",
      "https://github.com/dreamhunter2333/cloudflare_temp_email.git",
      "https://github.com/router-for-me/CLIProxyAPI.git",
      "configure_grok_cpa.py",
      "audit_stack.py",
      "retry_cpa_auth.py",
      "personal-team-blocked:spending-limit",
    ],
  ],
  [
    "sub2api-fork-deploy",
    [
      "com.docker.compose.project.working_dir",
      "If the user explicitly requests `$codex-luna`",
      "Never persist SSH passwords",
      "pg_restore --list",
      "Do not run `/app/sub2api --version` inside the live `sub2api` container",
      "config --format json",
      "--no-deps",
      "--pull never",
      "PostgreSQL and Redis container IDs and start times",
      "`docker compose pull` will fail",
      "Treat official catch-up as image convergence, not rollback",
      "Do not invoke Luna or rebuild an image for same-commit convergence",
      "git merge-base --is-ancestor",
      "Use `latest` for discovery only",
      'docker pull "$OFFICIAL_IMAGE"',
      "Keep the custom image until the official image passes the agreed soak period",
      "Do not restore PostgreSQL automatically",
    ],
  ],
  [
    "bytevirt-hysteria2-node",
    [
      "Prefer a no-panel Hysteria2 deployment unless the user explicitly asks for a management panel",
      "Install official Hysteria2 with `https://get.hy2.sh/`",
      "Use password auth plus `salamander` obfuscation by default",
      "hysteria-server.service",
      "server up and running",
      "If same-host Hysteria2 succeeds but an outside client times out",
      "ByteVirt hosts may have no local iptables/nft rules while upstream UDP is still closed",
      "hy2://<auth_password>@<ip>:443/",
      "Some clients accept `hysteria2://` while Shadowrocket commonly accepts `hy2://`",
      "If Shadowrocket's node row does not show a latency value",
      "https://cp.cloudflare.com/generate_204",
      "If the log shows `client connected` from the user's public address and browser trace shows `ip=<vps-ip>`",
    ],
  ],
  [
    "bytevirt-reality-node",
    [
      "Prefer a no-panel deployment unless the user explicitly asks for x-ui",
      "Run Xray as a dedicated `xray` system user, not root",
      "Password (PublicKey)",
      "www.cloudflare.com:443",
      "If the service exits with `open /etc/xray/config.json: permission denied`",
      "No `x-ui.service` is present unless explicitly requested",
    ],
  ],
  [
    "digitalocean-cf-vless-deploy",
    [
      "Cloudflare SSL/TLS mode should be `Full (strict)`",
      "Cloudflare edge certificates only cover the client-to-Cloudflare hop",
      "If the user only wants VPN, do not ask for a website domain",
      "Use `VLESS + WebSocket + TLS + 443`",
      "Existing `xray`/Reality/TCP listeners on `443` cannot be reused through Cloudflare orange cloud",
      "3x-ui v3 may generate a random panel port and base path",
      "do not trust the OpenAPI path blindly",
      "`certbot.timer` is the systemd renewal scheduler installed by Certbot",
      "Subscription decodes to `<vpn-domain>:443`",
      "check for local proxy/DNS interference",
      "For Shadowrocket, prefer importing the subscription URL",
      "Do not treat preferred IP/CNAME as the first deployment step",
    ],
  ],
]);

function parseFrontmatter(markdown, skillName) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error(`${skillName}: missing YAML frontmatter`);
  }

  const fields = new Map();
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (field) {
      const rawValue = field[2].trim();
      if (!isQuotedYamlScalar(rawValue) && /:\s/.test(rawValue)) {
        throw new Error(`${skillName}: frontmatter field ${field[1]} must quote values containing colon-space`);
      }
      fields.set(field[1], unquoteYamlScalar(rawValue));
    }
  }

  return fields;
}

function isQuotedYamlScalar(value) {
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
}

function unquoteYamlScalar(value) {
  return isQuotedYamlScalar(value) ? value.slice(1, -1) : value;
}

async function validateSkill(skillName) {
  const skillDir = path.join(skillsRoot, skillName);
  const skillPath = path.join(skillDir, "SKILL.md");
  const agentPath = path.join(skillDir, "agents", "openai.yaml");

  if (!existsSync(skillPath)) {
    throw new Error(`${skillName}: missing SKILL.md`);
  }
  if (!existsSync(agentPath)) {
    throw new Error(`${skillName}: missing agents/openai.yaml`);
  }

  const markdown = await readFile(skillPath, "utf8");
  const frontmatter = parseFrontmatter(markdown, skillName);
  if (frontmatter.get("name") !== skillName) {
    throw new Error(`${skillName}: frontmatter name must match directory name`);
  }
  if (!frontmatter.get("description")) {
    throw new Error(`${skillName}: missing frontmatter description`);
  }

  for (const marker of requiredBodyMarkers.get(skillName) ?? []) {
    if (!markdown.includes(marker)) {
      throw new Error(`${skillName}: missing marker ${JSON.stringify(marker)}`);
    }
  }
}

const entries = await readdir(skillsRoot, { withFileTypes: true });
const skillNames = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (skillNames.length === 0) {
  throw new Error("no skills found");
}

for (const skillName of skillNames) {
  await validateSkill(skillName);
}

console.log(`Validated ${skillNames.length} skill(s): ${skillNames.join(", ")}`);
