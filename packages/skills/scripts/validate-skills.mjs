import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(packageRoot, "skills");

const requiredBodyMarkers = new Map([
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
      "If the user only wants VPN, do not ask for a website domain",
      "Use `VLESS + WebSocket + TLS + 443`",
      "`certbot.timer` is the systemd renewal scheduler installed by Certbot",
      "Subscription decodes to `<vpn-domain>:443`",
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
  return (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"));
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
