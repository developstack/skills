#!/usr/bin/env node
/**
 * sync-skills.mjs — 把 `sources.yaml` 里的上游技能仓聚合进本仓。
 *
 * 产出（全部是**生成物**，不要手改）：
 *   skills/<slug>/SKILL.md            单技能目录（市场清单与 zip 的来源）
 *   .claude-plugin/marketplace.json   市场清单（平台 assets/market/registry.go 直接消费）
 *   dist/<slug>.zip                   单技能包（teamai `install_skill` 的 download_url）
 *   LOCK.json                         溯源：上游 repo / ref / commit / 路径 / sha256 / license
 *
 * 定位：**只聚合，不创作** —— 我们不是技能作者，是分发者。
 *
 * 学习点（两处硬约束）：
 *   1. slug 必须与平台 `assets/domain.NormalizeSlug` 完全一致 —— 平台下发的
 *      download_url 是 `{base}/{slug}.zip`，slug 算错就 404。
 *   2. zip 必须是**单技能包**且 SKILL.md 在根目录 —— teamai 用 `unzip` 解包后
 *      `findSkillRoot` 只取**第一个** SKILL.md，塞整仓归档会装错技能。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp-sync");
const SKILLS_DIR = path.join(ROOT, "skills");
const DIST_DIR = path.join(ROOT, "dist");
const MANIFEST = path.join(ROOT, ".claude-plugin", "marketplace.json");
const LOCK = path.join(ROOT, "LOCK.json");

/** normalizeSlug 与平台 assets/domain.NormalizeSlug 保持逐字符一致。 */
function normalizeSlug(raw) {
  let out = "";
  let prevDash = false;
  for (const ch of String(raw ?? "").trim().toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      out += ch;
      prevDash = false;
    } else if (!prevDash && out.length > 0) {
      out += "-";
      prevDash = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

/** parseFrontmatter 解析 SKILL.md 的 YAML frontmatter（name/description/license…）。 */
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    return YAML.parse(text.slice(3, end)) ?? {};
  } catch {
    return {};
  }
}

/** globToRegExp 把 `*` / `**` 形式的 glob 转成正则（够用即可，不引 glob 依赖）。 */
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** matchesAny 判断相对路径是否命中任一 glob。 */
function matchesAny(rel, globs) {
  return globs.some((glob) => globToRegExp(glob).test(rel));
}

/** toGlobs 归一化 include/exclude 配置（缺省 = 全收）。 */
function toGlobs(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item).trim()).filter(Boolean);
}

/** walk 递归列出文件（返回相对 root 的 posix 路径）。 */
async function walk(dir, root = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, root, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  return out;
}

/** resetDir 清空并重建目录（保留 .gitkeep）。 */
async function resetDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".gitkeep"), "");
}

/** ownerRepo 从仓库 URL 里取 `owner/repo`。 */
function ownerRepo(repo) {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo.trim());
  if (!match) throw new Error(`不是 GitHub 仓库地址：${repo}`);
  return { owner: match[1], repo: match[2] };
}

/** resolveCommit 用 ls-remote 解析 ref 的真实 commit（写进 LOCK 做溯源）。 */
async function resolveCommit(repo, ref) {
  const { stdout } = await run("git", ["ls-remote", repo, ref]);
  const sha = (stdout.trim().split("\n")[0] ?? "").split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`无法解析 ${repo}@${ref} 的 commit`);
  return sha;
}

/** downloadAndExtract 拉上游 tarball 并解到临时目录。 */
async function downloadAndExtract(repo, ref, name) {
  const { owner, repo: slug } = ownerRepo(repo);
  const url = `https://codeload.github.com/${owner}/${slug}/tar.gz/${ref}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${url}：HTTP ${res.status}`);
  const archive = path.join(TMP, `${name}.tar.gz`);
  await fs.writeFile(archive, Buffer.from(await res.arrayBuffer()));

  const dir = path.join(TMP, name);
  await fs.mkdir(dir, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", dir, "--strip-components=1"]);
  return dir;
}

/** findLicense 在上游仓根找一个 LICENSE 文件（聚合要保留上游许可）。 */
async function findLicense(repoDir) {
  const entries = await fs.readdir(repoDir, { withFileTypes: true }).catch(() => []);
  const hit = entries.find((e) => e.isFile() && /^LICENSE/i.test(e.name));
  return hit ? path.join(repoDir, hit.name) : null;
}

/** collectSkills 在上游仓里挑出要收的技能目录。 */
async function collectSkills(repoDir, include, exclude) {
  const files = await walk(repoDir);
  const picked = [];
  for (const rel of files) {
    if (path.posix.basename(rel) !== "SKILL.md") continue;
    if (include.length > 0 && !matchesAny(rel, include)) continue;
    if (exclude.length > 0 && matchesAny(rel, exclude)) continue;
    picked.push({ rel, dir: path.posix.dirname(rel) });
  }
  return picked.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** copySkill 把一个技能目录拷到 skills/<slug>/（顺带补上游 LICENSE）。 */
async function copySkill(repoDir, skillDir, slug, licensePath) {
  const from = path.join(repoDir, skillDir);
  const to = path.join(SKILLS_DIR, slug);
  await fs.rm(to, { recursive: true, force: true });
  await fs.mkdir(to, { recursive: true });
  await fs.cp(from, to, { recursive: true });

  if (licensePath) {
    const hasOwn = (await fs.readdir(to)).some((name) => /^LICENSE/i.test(name));
    if (!hasOwn) await fs.copyFile(licensePath, path.join(to, "LICENSE"));
  }
}

/** zipSkill 打成单技能 zip（zip 根目录即 SKILL.md 所在目录）。 */
async function zipSkill(slug) {
  const out = path.join(DIST_DIR, `${slug}.zip`);
  await run("zip", ["-q", "-r", out, "."], { cwd: path.join(SKILLS_DIR, slug) });
  return out;
}

/** sha256File 计算文件指纹（写进 LOCK）。 */
async function sha256File(file) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

/** syncSource 处理一个上游源，返回它贡献的技能 slug 列表。 */
async function syncSource(source) {
  const repo = String(source.repo ?? "").trim();
  const ref = String(source.ref ?? "main").trim();
  const namespace = String(source.namespace ?? "").trim() || ownerRepo(repo).repo;
  // 展示名：给人看的（表格里的「上游来源」）。缺省回落 namespace。
  const displayName = String(source.name ?? "").trim() || namespace;
  const include = toGlobs(source.include);
  const exclude = toGlobs(source.exclude);

  const commit = await resolveCommit(repo, ref);
  console.log(`\n▶ ${repo}@${ref} → ${displayName} [${namespace}] (${commit.slice(0, 8)})`);

  const repoDir = await downloadAndExtract(repo, ref, namespace);
  const licensePath = await findLicense(repoDir);
  const picked = await collectSkills(repoDir, include, exclude);
  if (picked.length === 0) {
    console.warn(`  ⚠ 没有匹配的技能（include=${include.join(",") || "*"}）`);
  }

  const contributed = [];
  for (const item of picked) {
    const text = await fs.readFile(path.join(repoDir, item.rel), "utf8");
    const frontmatter = parseFrontmatter(text);
    const slug = normalizeSlug(frontmatter.name ?? path.posix.basename(item.dir));
    if (!slug) {
      console.warn(`  ⚠ 跳过（slug 为空）：${item.rel}`);
      continue;
    }
    if (contributed.some((c) => c.slug === slug)) {
      console.warn(`  ⚠ 跳过（同一源内 slug 重复）：${item.rel} → ${slug}`);
      continue;
    }
    await copySkill(repoDir, item.dir, slug, licensePath);
    const zip = await zipSkill(slug);
    contributed.push({
      slug,
      name: String(frontmatter.name ?? slug),
      description: String(frontmatter.description ?? ""),
      license: String(frontmatter.license ?? ""),
      path: item.dir,
      lock: {
        source: repo,
        ref,
        commit,
        path: item.dir,
        sha256: await sha256File(zip),
        license: String(frontmatter.license ?? ""),
      },
    });
    console.log(`  ✓ ${slug}${frontmatter.name && normalizeSlug(frontmatter.name) !== slug ? ` (name=${frontmatter.name})` : ""}`);
  }
  return { namespace, displayName, contributed };
}

/** writeManifest 生成 .claude-plugin/marketplace.json（形状由平台解析器决定）。 */
async function writeManifest(groups, version) {
  const plugins = groups.map((group) => ({
    name: group.namespace,
    // display_name 是**我们加的扩展字段**（Claude Code 插件市场格式只规定 name/description）。
    // 学习点：多出来的键对其它消费者是无害的（JSON 解析器会忽略未知字段），
    // 而平台据此在表格里显示"上游来源"的人话名字。
    display_name: group.displayName,
    description: group.description,
    skills: group.skills.map((slug) => `./skills/${slug}`),
  }));
  const doc = { name: "developstack-skills", metadata: { version }, plugins };
  await fs.mkdir(path.dirname(MANIFEST), { recursive: true });
  await fs.writeFile(MANIFEST, `${JSON.stringify(doc, null, 2)}\n`);
  return plugins.reduce((sum, plugin) => sum + plugin.skills.length, 0);
}

async function main() {
  const raw = await fs.readFile(path.join(ROOT, "sources.yaml"), "utf8");
  const sources = YAML.parse(raw)?.sources ?? [];
  if (sources.length === 0) throw new Error("sources.yaml 里没有 sources");

  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
  await resetDir(SKILLS_DIR);
  await resetDir(DIST_DIR);

  const groups = [];
  const lock = {};
  const taken = new Map();

  for (const source of sources) {
    const { namespace, displayName, contributed } = await syncSource(source);
    const skills = [];
    for (const item of contributed) {
      const previous = taken.get(item.slug);
      if (previous) {
        console.warn(`  ⚠ 跨源 slug 冲突：${item.slug} 已在 ${previous}，此处跳过`);
        continue;
      }
      taken.set(item.slug, namespace);
      lock[item.slug] = item.lock;
      skills.push(item.slug);
    }
    if (skills.length > 0) {
      groups.push({ namespace, displayName, description: source.description ?? "", skills });
    }
  }

  const version = new Date().toISOString().slice(0, 10);
  const total = await writeManifest(groups, version);
  await fs.writeFile(LOCK, `${JSON.stringify({ version, skills: lock }, null, 2)}\n`);
  await fs.rm(TMP, { recursive: true, force: true });

  console.log(`\n✅ 聚合完成：${groups.length} 个 namespace / ${total} 个技能`);
}

await main();
