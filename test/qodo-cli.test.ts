// Tests `.github/polson/qodo-cli.sh install`, which the verify-qodo job uses to
// install the pinned Qodo CLI into a temporary QODO_HOME. A stand-in curl serves a
// stand-in installer, so no network or real CLI is needed; the real sha256sum checks
// it. Issue: https://github.com/shrooms08/polson/issues/26
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const QODO_CLI = resolve(import.meta.dirname, "../.github/polson/qodo-cli.sh");

// Installs a `qodo` that prints the requested version, and records the environment
// it was run with in $HOME (the installer only sees allowlisted variables).
const INSTALLER = `#!/bin/sh
env | sort > "$HOME/installer-env.txt"
[ "$1" = "--version" ] || exit 3
mkdir -p "$QODO_HOME/bin"
printf '#!/bin/sh\\necho %s\\n' "$2" > "$QODO_HOME/bin/qodo"
chmod +x "$QODO_HOME/bin/qodo"
`;
const INSTALLER_SHA256 = createHash("sha256").update(INSTALLER).digest("hex");

// curl -o <file> <url>: copies the stand-in installer, for the pinned URL only.
const STUB_CURL = `#!/usr/bin/env bash
out=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --max-time) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
[ "$url" = "https://example.invalid/install.sh" ] || { echo "stand-in curl: unexpected url $url" >&2; exit 22; }
cp "$HOME/install.sh" "$out"
`;

const GITHUB_SECRETS = {
  GH_TOKEN: "gh-token-must-not-leak",
  GITHUB_TOKEN: "github-token-must-not-leak",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token-must-not-leak",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/must-not-leak",
  ACTIONS_RUNTIME_TOKEN: "runtime-token-must-not-leak",
};

describe("qodo-cli.sh install", () => {
  let dir: string;
  let qodoHome: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-qodo-cli-"));
    qodoHome = join(dir, "runner-temp", "qodo-home");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "install.sh"), INSTALLER);
    writeFileSync(join(dir, "bin", "curl"), STUB_CURL);
    chmodSync(join(dir, "bin", "curl"), 0o755);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function install(env: Record<string, string> = {}) {
    return spawnSync("bash", [QODO_CLI, "install"], {
      encoding: "utf8",
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        HOME: dir,
        QODO_HOME: qodoHome,
        QODO_INSTALLER_URL: "https://example.invalid/install.sh",
        QODO_INSTALLER_SHA256: INSTALLER_SHA256,
        QODO_CLI_VERSION: "2.4.0",
        QODO_API_KEY: "qodo-key-the-installer-does-not-need",
        ...GITHUB_SECRETS,
        ...env,
      },
    });
  }

  // Measured: 38-51 ms on the agent's GitHub runner and about 1.8 s on a macOS dev machine.
  // It runs the real script, which starts several short processes.
  // It once took 5111 ms in a local full-suite run during PR #50 validation (issue #51),
  // against the 5000 ms default; that run was not reproduced and its cause is unknown.
  // The explicit 30 s keeps one slow run from failing the test; the global timeout is unchanged.
  it("installs the pinned CLI version into QODO_HOME", { timeout: 30_000 }, () => {
    const r = install();

    expect(r.status, r.stderr).toBe(0);
    const version = spawnSync(join(qodoHome, "bin", "qodo"), ["--version"], { encoding: "utf8" });
    expect(version.stdout.trim()).toBe("2.4.0");
  });

  it("refuses an installer whose SHA-256 does not match, and runs nothing", () => {
    const r = install({ QODO_INSTALLER_SHA256: "0".repeat(64) });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SHA-256 mismatch");
    expect(existsSync(join(dir, "installer-env.txt"))).toBe(false);
    expect(existsSync(join(qodoHome, "bin", "qodo"))).toBe(false);
  });

  it("runs the installer with an allowlist: no GitHub token, no Qodo key", () => {
    const r = install();

    expect(r.status, r.stderr).toBe(0);
    const seen = readFileSync(join(dir, "installer-env.txt"), "utf8");
    expect(seen).toContain(`QODO_HOME=${qodoHome}`);
    for (const [name, value] of Object.entries(GITHUB_SECRETS)) {
      expect(seen).not.toContain(`${name}=`);
      expect(seen).not.toContain(value);
    }
    expect(seen).not.toContain("QODO_API_KEY");
  });
});
