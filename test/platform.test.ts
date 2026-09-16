import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveShell, shellInvocation, shellSpecFromCommand, shellSyntaxNote } from "../src/platform.js";

const NO_GIT_BASH = { ProgramFiles: join(tmpdir(), "definitely-missing-program-files") };

test("POSIX hosts trust $SHELL and fall back to zsh or bash", () => {
  assert.deepEqual(resolveShell({ SHELL: "/opt/homebrew/bin/fish" }, "darwin"), {
    command: "/opt/homebrew/bin/fish",
    family: "posix",
    source: "SHELL",
  });
  assert.equal(resolveShell({}, "darwin").command, "/bin/zsh");
  assert.equal(resolveShell({}, "linux").command, "/bin/bash");
  assert.equal(resolveShell({ SHELL: "   " }, "linux").command, "/bin/bash");
});

test("HARNESS_SHELL overrides every other source on every platform", () => {
  assert.deepEqual(resolveShell({ HARNESS_SHELL: "/usr/local/bin/bash", SHELL: "/bin/sh" }, "linux"), {
    command: "/usr/local/bin/bash",
    family: "posix",
    source: "HARNESS_SHELL",
  });
  const cmd = resolveShell({ HARNESS_SHELL: "C:\\Windows\\System32\\cmd.exe", ...NO_GIT_BASH }, "win32");
  assert.equal(cmd.family, "cmd");
  assert.equal(cmd.source, "HARNESS_SHELL");
});

test("Windows without Git Bash falls back to cmd.exe from COMSPEC", () => {
  assert.deepEqual(resolveShell(NO_GIT_BASH, "win32"), { command: "cmd.exe", family: "cmd", source: "default" });
  assert.deepEqual(resolveShell({ ...NO_GIT_BASH, ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" }, "win32"), {
    command: "C:\\WINDOWS\\system32\\cmd.exe",
    family: "cmd",
    source: "default",
  });
});

test("Windows ignores an MSYS-style SHELL that Node cannot spawn", () => {
  // Git Bash exports SHELL=/usr/bin/bash inside its own sessions.
  const spec = resolveShell({ ...NO_GIT_BASH, SHELL: "/usr/bin/bash" }, "win32");
  assert.equal(spec.family, "cmd");
  assert.equal(spec.source, "default");
});

test("Windows prefers an installed Git Bash over cmd.exe", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-gitbash-"));
  try {
    const bash = join(root, "Git", "bin", "bash.exe");
    await mkdir(join(root, "Git", "bin"), { recursive: true });
    await writeFile(bash, "#!/bin/sh\n");
    await chmod(bash, 0o755);

    const viaProgramFiles = resolveShell({ ProgramFiles: root }, "win32");
    assert.deepEqual(viaProgramFiles, { command: bash, family: "posix", source: "git-bash" });

    // EXEPATH is what Git Bash itself exports, pointing at the install root.
    const viaExePath = resolveShell({ EXEPATH: join(root, "Git"), ...NO_GIT_BASH }, "win32");
    assert.equal(viaExePath.command, bash);

    // A LOCALAPPDATA per-user install lives under Programs\Git.
    await mkdir(join(root, "Programs", "Git", "bin"), { recursive: true });
    const userBash = join(root, "Programs", "Git", "bin", "bash.exe");
    await writeFile(userBash, "#!/bin/sh\n");
    await chmod(userBash, 0o755);
    const viaLocalAppData = resolveShell({ LOCALAPPDATA: root, ...NO_GIT_BASH }, "win32");
    assert.equal(viaLocalAppData.command, userBash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shellInvocation builds a login-shell argv for POSIX and a verbatim /c line for cmd.exe", () => {
  assert.deepEqual(shellInvocation({ command: "/bin/bash", family: "posix", source: "default" }, "echo hi && ls"), {
    command: "/bin/bash",
    args: ["-lc", "echo hi && ls"],
    windowsVerbatimArguments: false,
  });
  assert.deepEqual(shellInvocation({ command: "cmd.exe", family: "cmd", source: "default" }, 'echo "hi there" && dir'), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '"echo "hi there" && dir"'],
    windowsVerbatimArguments: true,
  });
});

test("a caller-supplied shell string is classified by its executable name", () => {
  assert.equal(shellSpecFromCommand("/bin/sh").family, "posix");
  assert.equal(shellSpecFromCommand("C:\\Program Files\\Git\\bin\\bash.exe").family, "posix");
  assert.equal(shellSpecFromCommand("C:\\Windows\\System32\\cmd.exe").family, "cmd");
  assert.equal(shellSpecFromCommand("cmd").family, "cmd");
});

test("the syntax note only appears where the model would otherwise guess wrong", () => {
  assert.equal(shellSyntaxNote({ command: "/bin/zsh", family: "posix", source: "default" }, "darwin"), "");
  assert.match(shellSyntaxNote({ command: "cmd.exe", family: "cmd", source: "default" }, "win32"), /cmd\.exe/);
  assert.match(
    shellSyntaxNote({ command: "C:\\Git\\bin\\bash.exe", family: "posix", source: "git-bash" }, "win32"),
    /Git Bash/,
  );
});
