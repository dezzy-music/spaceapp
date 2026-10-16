import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  composeCommand,
  createDefaultConfig,
  renderPodmanCompose,
  renderWorkspaceCompose,
  validateConfig
} from "../src/index.mjs";
import {
  checkPodmanMachineResources,
  detectAvailableEngines,
  podmanIsReady
} from "../src/prerequisites.mjs";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) {
            return { done: true };
          }
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
}

const FRESH_APPROVALS = ["", "", "", "", "", "y"];

test("validateConfig and createDefaultConfig enforce engine validity and disallow podman with host-root", () => {
  const dockerConfig = createDefaultConfig({ version: "1.0.0", engine: "docker" });
  assert.equal(dockerConfig.engine, "docker");
  assert.doesNotThrow(() => validateConfig(dockerConfig));

  const podmanConfig = createDefaultConfig({ version: "1.0.0", engine: "podman" });
  assert.equal(podmanConfig.engine, "podman");
  assert.doesNotThrow(() => validateConfig(podmanConfig));

  assert.throws(
    () => createDefaultConfig({ version: "1.0.0", engine: "nerdctl" }),
    /engine must be docker or podman/
  );

  assert.throws(
    () => createDefaultConfig({ version: "1.0.0", engine: "podman", accessMode: "host-root" }),
    /host-root access is not supported with the podman engine/i
  );

  const invalidAccessPodman = { ...podmanConfig, accessMode: "host-root" };
  assert.throws(
    () => validateConfig(invalidAccessPodman),
    /host-root access is not supported with the podman engine/i
  );
});

test("renderPodmanCompose generates keep-id userns_mode for unprivileged rootless services", () => {
  const composeYaml = renderPodmanCompose();
  assert.match(composeYaml, /userns_mode:\s*"keep-id:uid=10001,gid=10001"/);
  assert.match(composeYaml, /spaceapp-core:/);
  assert.match(composeYaml, /spaceapp-cli:/);
  assert.match(composeYaml, /spaceapp-browser:/);
});

test("renderWorkspaceCompose injects SELinux relabeling (:z) when engine is podman", () => {
  const dockerWorkspaces = renderWorkspaceCompose({
    ...createDefaultConfig({ version: "1.0.0", engine: "docker" }),
    workspaces: [{
      id: "project-12345678",
      name: "project",
      hostPath: "/home/user/project",
      containerPath: "/workspaces/project",
      readOnly: false
    }]
  });
  assert.doesNotMatch(dockerWorkspaces, /selinux:\s*"z"/);

  const podmanWorkspaces = renderWorkspaceCompose({
    ...createDefaultConfig({ version: "1.0.0", engine: "podman" }),
    workspaces: [{
      id: "project-12345678",
      name: "project",
      hostPath: "/home/user/project",
      containerPath: "/workspaces/project",
      readOnly: false
    }]
  });
  assert.match(podmanWorkspaces, /bind:\s*\n\s+selinux:\s*"z"/);
});

test("composeCommand generates podman compose invocations with compose.podman.yml", () => {
  const root = join(tmpdir(), "spaceapp-test-podman-compose");
  const command = composeCommand("up", root, { engine: "podman", profile: "small" });
  assert.equal(command.command, "podman");
  assert.equal(command.args[0], "compose");
  assert.ok(command.args.includes(join(root, "compose.podman.yml")));
  assert.ok(command.args.includes("up"));
});

test("checkPodmanMachineResources verifies macOS podman machine resources and formats resize guidance", async () => {
  const sufficientExecute = async (spec, io) => {
    if (spec.command === "podman" && spec.args?.[0] === "machine" && spec.args?.[1] === "inspect") {
      io.stdout.write(JSON.stringify([{
        Running: true,
        Resources: { CPUs: 8, Memory: 16384, DiskSize: 100 }
      }]));
      return 0;
    }
    return 1;
  };
  const sufficient = await checkPodmanMachineResources(sufficientExecute, { profile: "large" });
  assert.equal(sufficient.ok, true);

  const deficientExecute = async (spec, io) => {
    if (spec.command === "podman" && spec.args?.[0] === "machine" && spec.args?.[1] === "inspect") {
      io.stdout.write(JSON.stringify([{
        Running: true,
        Resources: { CPUs: 2, Memory: 2048, DiskSize: 20 }
      }]));
      return 0;
    }
    return 1;
  };
  const deficient = await checkPodmanMachineResources(deficientExecute, { profile: "medium" });
  assert.equal(deficient.ok, false);
  assert.match(deficient.detail, /podman machine set --cpus 4 --memory 11264/);
});

test("install --engine podman succeeds, configures podman engine, and creates runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-install-podman-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];

  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin(...FRESH_APPROVALS),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3
    }),
    request: async (url) => {
      if (url.endsWith("/readyz")) return { ok: true, json: async () => ({ ok: true }) };
      if (url.endsWith("/api/setup/status")) return { ok: true, json: async () => ({ setupRequired: false, expiresAt: null }) };
      return { ok: true };
    },
    sleep: async () => {},
    ensurePodman: async () => ({ code: 0, reexecuted: false }),
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  };

  const code = await run(["install", "--engine", "podman", "--profile", "small", "--no-open"], options);
  assert.equal(code, 0);

  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  assert.equal(config.profile, "small");

  const composePodmanContent = await readFile(join(root, "compose.podman.yml"), "utf8");
  assert.match(composePodmanContent, /userns_mode:\s*"keep-id:uid=10001,gid=10001"/);

  const pullCall = calls.find((c) => c.command === "podman" && c.args?.includes("pull"));
  assert.ok(pullCall, "podman compose pull should have been executed");
  assert.ok(pullCall.args.some((arg) => arg.endsWith("compose.podman.yml")));

  const upCall = calls.find((c) => c.command === "podman" && c.args?.includes("up"));
  assert.ok(upCall, "podman compose up should have been executed");
  assert.ok(upCall.args.some((arg) => arg.endsWith("compose.podman.yml")));
});

test("install --engine podman refuses --access host-root with a clear error message", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-hostroot-podman-"));
  const stdout = capture();
  const stderr = capture();

  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin(...FRESH_APPROVALS),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3
    }),
    execute: async () => 0
  };

  await assert.rejects(
    async () => {
      await run(["install", "--engine", "podman", "--access", "host-root", "--no-open"], options);
    },
    /host-root access is not supported with the podman engine/i
  );
});

test("switching engines on existing installation is refused with a migration guidance error", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-switch-engine-"));
  const stdout = capture();
  const stderr = capture();

  await writeFile(
    join(root, "config.json"),
    JSON.stringify(createDefaultConfig({ version: "1.0.0", engine: "docker" })),
    "utf8"
  );

  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("y"),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3
    }),
    execute: async () => 0
  };

  await assert.rejects(
    async () => {
      await run(["install", "--engine", "podman", "--no-open"], options);
    },
    /Switching container engine from "docker" to "podman" is not supported on an existing installation/i
  );
});

test("doctor and support-bundle report podman facts (rootless, cgroup v2, limits delegation)", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-doctor-podman-"));
  const stdout = capture();
  const stderr = capture();

  await writeFile(
    join(root, "config.json"),
    JSON.stringify(createDefaultConfig({ version: "1.0.0", engine: "podman" })),
    "utf8"
  );

  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin(),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3
    }),
    execute: async (spec, io) => {
      if (spec.command === "podman" && spec.args?.includes("info")) {
        io?.stdout?.write(JSON.stringify({
          version: { Version: "5.0.3" },
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"]
          }
        }));
        return 0;
      }
      return 0;
    }
  };

  const doctorCode = await run(["doctor"], options);
  assert.equal(doctorCode, 0);
  assert.match(stdout.value(), /PASS Podman CLI: version 5\.0\.3/);
  assert.match(stdout.value(), /PASS Podman Compose: available/);
  assert.match(stdout.value(), /PASS Podman Engine: available \(rootless, cgroup v2\)/);
  assert.match(stdout.value(), /PASS Resource delegation: CPU and memory limits delegated/);

  const bundlePath = join(root, "bundle.json");
  const bundleCode = await run(["support-bundle", "--out", bundlePath], options);
  assert.equal(bundleCode, 0);
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundle.engine?.name, "podman");
  assert.equal(bundle.engine?.rootless, true);
  assert.equal(bundle.engine?.cgroupVersion, "v2");
  assert.equal(bundle.engine?.limitsDelegated, true);
});

test("factory-reset preserves configured engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-factory-reset-podman-"));
  const stdout = capture();
  const stderr = capture();

  await writeFile(
    join(root, "config.json"),
    JSON.stringify(createDefaultConfig({ version: "1.0.0", engine: "podman" })),
    "utf8"
  );
  await writeFile(join(root, "compose.podman.yml"), "services: {}\n", "utf8");

  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("FACTORY-RESET"),
    execute: async () => 0
  };

  const code = await run(["factory-reset"], options);
  assert.equal(code, 0);
  assert.match(stdout.value(), /SpaceApp factory reset complete/);

  const resetConfig = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(resetConfig.engine, "podman");
});
