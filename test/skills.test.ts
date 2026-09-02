import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSkillTool,
  discoverSkills,
  parseFrontmatter,
  skillDirsFromEnv,
} from "../src/agent/skills.js";
import { buildAgentSystemPrompt } from "../src/agent/system-prompt.js";
import { createWorkspaceTools } from "../src/agent/tools.js";

async function writeSkill(
  root: string,
  dir: string,
  name: string,
  description: string,
  body = `# ${name}\n\nDo the ${name} thing.\n`,
): Promise<string> {
  const directory = join(root, dir, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
  return directory;
}

test("parseFrontmatter handles scalars, quotes, folded blocks, and continuation lines", () => {
  const parsed = parseFrontmatter(
    [
      "---",
      "name: release-notes",
      'description: "Draft release notes, from git history"',
      "license: >-",
      "  MIT",
      "  License",
      "compatibility: Requires git",
      "  and network access",
      "---",
      "# Body",
      "",
    ].join("\n"),
  );
  assert.equal(parsed.fields.name, "release-notes");
  assert.equal(parsed.fields.description, "Draft release notes, from git history");
  assert.equal(parsed.fields.license, "MIT License");
  assert.equal(parsed.fields.compatibility, "Requires git and network access");
  assert.equal(parsed.body.trim(), "# Body");

  const plain = parseFrontmatter("# No frontmatter\n");
  assert.deepEqual(plain.fields, {});
  assert.equal(plain.body, "# No frontmatter\n");
});

test("discoverSkills searches Copilot-compatible locations with project precedence", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "copilot-skills-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = join(parent, "project");
  const home = join(parent, "home");
  const extra = join(parent, "extra");
  await mkdir(project, { recursive: true });
  await writeSkill(project, ".github/skills", "deploy", "Deploy from the repository");
  await writeSkill(project, ".claude/skills", "review", "Review a diff");
  await writeSkill(project, ".agents/skills", "deploy", "Shadowed duplicate");
  await writeSkill(home, ".copilot/skills", "deploy", "Personal duplicate");
  await writeSkill(home, ".copilot/skills", "notes", "Take meeting notes");
  await writeSkill(extra, ".", "lint", "Run the linters");
  await mkdir(join(project, ".github", "skills", "no-skill-file"));
  // A SKILL.md without frontmatter falls back to the directory name and first line.
  await mkdir(join(project, ".github", "skills", "bare"), { recursive: true });
  await writeFile(join(project, ".github", "skills", "bare", "SKILL.md"), "Bare instructions here.\n");

  const skills = await discoverSkills(project, { home, extraDirs: [extra] });
  assert.deepEqual(
    skills.map((skill) => [skill.name, skill.source, skill.description]),
    [
      ["bare", "project", "Bare instructions here."],
      ["deploy", "project", "Deploy from the repository"],
      ["review", "project", "Review a diff"],
      ["lint", "env", "Run the linters"],
      ["notes", "personal", "Take meeting notes"],
    ],
  );
  assert.equal(skills.find((skill) => skill.name === "deploy")?.directory, join(project, ".github", "skills", "deploy"));
});

test("skillDirsFromEnv splits COPILOT_SKILLS_DIRS", () => {
  assert.deepEqual(skillDirsFromEnv(undefined), []);
  assert.deepEqual(skillDirsFromEnv(" /a/skills, /b/skills "), ["/a/skills", "/b/skills"]);
});

test("skill tool lists, loads, and reads bundled files without escaping the skill", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "copilot-skills-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = join(parent, "project");
  const home = join(parent, "home");
  await mkdir(home, { recursive: true });
  const directory = await writeSkill(project, ".github/skills", "deploy", "Deploy from the repository");
  await mkdir(join(directory, "references"));
  await writeFile(join(directory, "references", "steps.md"), "step one\nstep two\n");
  await writeFile(join(parent, "secret.txt"), "outside\n");
  await symlink(join(parent, "secret.txt"), join(directory, "link.txt"));

  const tool = createSkillTool(() => project, { home, extraDirs: [] });
  assert.equal(tool.mutates, false);
  assert.match(await tool.execute({}), /- deploy \(project\): Deploy from the repository/);

  const loaded = await tool.execute({ name: "deploy" });
  assert.match(loaded, /^Skill: deploy\n/);
  assert.match(loaded, /Do the deploy thing\./);
  assert.doesNotMatch(loaded, /^---/m);
  assert.match(loaded, /Bundled files[\s\S]*- references\/steps\.md/);

  assert.match(await tool.execute({ name: "Deploy", file: "references/steps.md" }), /2: step two/);
  await assert.rejects(tool.execute({ name: "deploy", file: "../../../secret.txt" }), /escapes/);
  await assert.rejects(tool.execute({ name: "deploy", file: "link.txt" }), /resolves outside/);
  await assert.rejects(tool.execute({ name: "missing" }), /Unknown skill: missing\. Available skills: deploy/);
  await assert.rejects(tool.execute({ file: "x" }), /file requires a skill name/);
});

test("workspace tools include the read-only skill tool and the prompt advertises skills", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "copilot-skills-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = join(parent, "project");
  await writeSkill(project, ".github/skills", "deploy", "Deploy from the repository");
  await mkdir(join(project, ".github"), { recursive: true });
  await writeFile(join(project, ".github", "copilot-instructions.md"), "Always run tests.\n");

  const tools = await createWorkspaceTools(project);
  const skill = tools.find((tool) => tool.name === "skill");
  assert.ok(skill);
  assert.equal(skill.mutates, false);

  const skills = await discoverSkills(project, { home: parent, extraDirs: [] });
  const prompt = await buildAgentSystemPrompt({ cwd: project, tools, skills });
  assert.match(prompt, /- skill \(read-only\)/);
  assert.match(prompt, /<available_skills>[\s\S]*- deploy: Deploy from the repository[\s\S]*<\/available_skills>/);
  assert.match(prompt, /<project_instructions path="\.github\/copilot-instructions\.md">\nAlways run tests\./);

  const bare = await buildAgentSystemPrompt({ cwd: project, tools, skills: [] });
  assert.doesNotMatch(bare, /<available_skills>/);
});
