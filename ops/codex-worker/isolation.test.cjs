"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { isIP } = require("node:net");

const root = path.resolve(__dirname, "../..");
const composePath = path.join(__dirname, "compose.yaml");
const compose = () => readFileSync(composePath, "utf8");
const RUNTIME_ENVIRONMENT = [
  "CODEX_TRANSPORT_CONTAINER",
  "CODEX_EXECUTOR_CONTAINER",
  "CODEX_ISOLATION_FORBIDDEN_TARGETS",
  "CODEX_INFERENCE_FIXTURE_PROXY_URL",
  "CODEX_INFERENCE_FIXTURE_TARGET",
  "CODEX_ISOLATION_FORBIDDEN_NETWORKS",
  "CODEX_ISOLATION_LISTENER_COUNTERS_URL",
  "CODEX_PROVIDER_CALL_COUNTER_URL",
];

function requireRuntimeEnvironment(environment = process.env) {
  const missing = RUNTIME_ENVIRONMENT.filter((name) => !environment[name]);
  assert.equal(
    missing.length,
    0,
    `missing required isolation environment: ${missing.join(", ")}`,
  );
}

function numericHttpUrl(value, label) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:", `${label} must use HTTP`);
  assert.equal(isIP(url.hostname), 4, `${label} must use a numeric IPv4 address`);
  return url;
}

async function preflightFakeListeners(targets, fetchImpl = fetch) {
  for (const target of targets) {
    const healthUrl = numericHttpUrl(
      target.healthUrl,
      `${target.name} fake listener health URL`,
    );
    assert.equal(
      healthUrl.pathname,
      "/health",
      `${target.name} health URL must not hit a protected listener route`,
    );
    const response = await fetchImpl(healthUrl, {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(
      response.status,
      200,
      `${target.name} fake listener is not healthy before denial probes`,
    );
    const status = await response.json();
    assert.equal(
      status?.healthy,
      true,
      `${target.name} fake listener did not report healthy`,
    );
  }
}

function serviceBlock(source, name) {
  const start = source.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} service`);
  const remaining = source.slice(start + 1);
  const nextService = remaining.search(/^  [a-z0-9_-]+:\s*$/m);
  return nextService === -1 ? remaining : remaining.slice(0, nextService + 1);
}

test("worker images keep the executor runtime free of Core modules", () => {
  const dockerfile = readFileSync(
    path.join(root, "Dockerfile.codex-worker"),
    "utf8",
  );

  assert.match(dockerfile, /AS transport\b/);
  assert.match(dockerfile, /AS executor\b/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /dist\/codex-worker/);
  assert.match(dockerfile, /dist\/rovelle\/creative/);
  const sharedRuntime = dockerfile.slice(
    dockerfile.indexOf("FROM ${NODE_IMAGE} AS worker-runtime"),
    dockerfile.indexOf("FROM worker-runtime AS transport"),
  );
  assert.match(sharedRuntime, /@nestjs\/common@10\.4\.22/);
  const executorRuntime = dockerfile.slice(
    dockerfile.indexOf("FROM worker-runtime AS executor-runtime"),
  );
  assert.match(executorRuntime, /@openai\/codex-sdk@0\.154\.0/);
  assert.doesNotMatch(
    dockerfile.slice(
      0,
      dockerfile.indexOf("FROM worker-runtime AS executor-runtime"),
    ),
    /@openai\/codex-sdk/,
    "transport must not include the SDK runtime",
  );
  assert.doesNotMatch(
    dockerfile,
    /COPY --from=build \/app\/dist \.\/dist\s*$/m,
  );
  assert.doesNotMatch(dockerfile, /@prisma|\bpg\b|nest start/);
});

test("package scripts expose the two isolated runtime roles", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );

  assert.equal(
    packageJson.scripts["start:codex-worker"],
    "node dist/codex-worker/main.js transport",
  );
  assert.equal(
    packageJson.scripts["start:codex-executor"],
    "node dist/codex-worker/main.js executor",
  );
  assert.equal(
    packageJson.scripts["test:codex-worker:isolation"],
    "node --test --test-reporter=spec ops/codex-worker/isolation.test.cjs",
  );
  assert.equal(
    packageJson.scripts["test:codex-worker:isolation:runtime"],
    "CODEX_ISOLATION_TEST_RUNTIME=1 node --test --test-reporter=spec ops/codex-worker/isolation.test.cjs",
  );
});

test("Compose keeps transport and executor privileges, mounts and networks split", () => {
  const source = compose();
  const transport = serviceBlock(source, "transport");
  const executor = serviceBlock(source, "executor");

  for (const service of [transport, executor]) {
    assert.match(service, /read_only:\s*true/);
    assert.match(service, /cap_drop:\s*\[ALL\]/);
    assert.match(service, /no-new-privileges:true/);
    assert.doesNotMatch(service, /privileged:\s*true/);
    assert.doesNotMatch(service, /\/var\/run\/docker\.sock|:\/app\b|\.\/src:/);
    assert.doesNotMatch(service, /^\s+ports:/m);
    assert.doesNotMatch(service, /pid:\s*(?:host|service:)/);
  }

  assert.match(transport, /user:\s*"[1-9][0-9]*:[1-9][0-9]*"/);
  assert.match(executor, /user:\s*"[1-9][0-9]*:[1-9][0-9]*"/);
  assert.match(transport, /\/var\/lib\/codex-worker/);
  assert.doesNotMatch(executor, /\/var\/lib\/codex-worker/);
  assert.match(executor, /tmpfs:/);
  assert.match(transport, /n8n_forward:/);
  assert.match(transport, /codex_execution:/);
  assert.match(executor, /codex_execution:/);
  assert.match(executor, /codex_inference_proxy:/);
  assert.doesNotMatch(executor, /n8n_forward:/);
  assert.match(source, /internal:\s*true/);
  assert.match(source, /private PID namespace per service/);
  for (const service of [transport, executor]) {
    assert.match(service, /net\.ipv6\.conf\.all\.disable_ipv6:\s*["']?1/);
    assert.match(service, /net\.ipv6\.conf\.default\.disable_ipv6:\s*["']?1/);
  }
  assert.match(source, /bridge\.name:\s*br-codex-exec/);
});

test("host nftables policy allowlists worker flows and drops other egress", () => {
  const rules = readFileSync(
    path.join(__dirname, "network-policy.nft"),
    "utf8",
  );

  assert.match(rules, /hook forward/);
  assert.match(rules, /ct state established,related accept/);
  assert.match(rules, /CODEX_TRANSPORT_EXECUTION_IP/);
  assert.match(rules, /CODEX_EXECUTOR_EXECUTION_IP/);
  assert.match(rules, /CODEX_EXECUTOR_PROXY_IP/);
  assert.match(rules, /CODEX_INFERENCE_PROXY_IP/);
  assert.match(rules, /CODEX_N8N_SUBNET/);
  assert.match(rules, /tcp dport 8081.*accept/);
  assert.match(rules, /tcp dport \{ 5678, 443 \}.*accept/);
  assert.match(rules, /CODEX_INFERENCE_PROXY_PORT.*accept/);
  assert.match(rules, /CODEX_EXECUTOR_EXECUTION_IP.*drop/);
  assert.match(rules, /CODEX_EXECUTOR_PROXY_IP.*drop/);
  assert.match(rules, /CODEX_EXECUTION_BRIDGE_IF/);
  assert.match(rules, /CODEX_PROXY_BRIDGE_IF/);
  assert.match(rules, /meta nfproto ipv6 iifname.*drop/);
  assert.match(rules, /meta nfproto ipv6 oifname.*drop/);
  assert.ok(
    rules.indexOf("meta nfproto ipv6") <
      rules.indexOf("ct state established,related accept"),
    "IPv6 drops must also cover established bridge traffic",
  );
});

test("runtime isolation configuration fails closed when required env is absent", () => {
  assert.throws(
    () => requireRuntimeEnvironment({}),
    /CODEX_TRANSPORT_CONTAINER.*CODEX_EXECUTOR_CONTAINER.*CODEX_ISOLATION_FORBIDDEN_TARGETS.*CODEX_INFERENCE_FIXTURE_PROXY_URL.*CODEX_INFERENCE_FIXTURE_TARGET.*CODEX_ISOLATION_FORBIDDEN_NETWORKS.*CODEX_ISOLATION_LISTENER_COUNTERS_URL.*CODEX_PROVIDER_CALL_COUNTER_URL/,
  );
});

test("listener preflight stops before denial probes when a fake service is unhealthy", async () => {
  const requests = [];
  await assert.rejects(
    preflightFakeListeners(
      [
        { name: "core", healthUrl: "http://127.0.0.1:18080/health" },
        { name: "n8n", healthUrl: "http://127.0.0.1:15678/health" },
      ],
      async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ healthy: false }), {
          status: 503,
        });
      },
    ),
    /core fake listener is not healthy before denial probes/,
  );
  assert.deepEqual(requests, ["http://127.0.0.1:18080/health"]);
});

test("runtime isolation awaits listener preflight before denial probes", () => {
  const source = readFileSync(__filename, "utf8");
  const runtimeStart = source.indexOf(
    'test(\n  "runtime isolation checks require an explicitly prepared CI/staging network"',
  );
  assert.ok(runtimeStart >= 0, "missing runtime isolation test");
  const runtime = source.slice(runtimeStart);
  const preflight = runtime.indexOf(
    "await preflightFakeListeners(forbiddenTargets)",
  );
  const denialProbe = runtime.indexOf("const deniedScript =");
  assert.ok(preflight >= 0 && preflight < denialProbe);
});

test(
  "runtime isolation checks require an explicitly prepared CI/staging network",
  {
    skip: process.env.CODEX_ISOLATION_TEST_RUNTIME !== "1",
  },
  async (t) => {
    requireRuntimeEnvironment();
    const transportContainer = process.env.CODEX_TRANSPORT_CONTAINER;
    const executorContainer = process.env.CODEX_EXECUTOR_CONTAINER;
    const forbiddenTargets = JSON.parse(
      process.env.CODEX_ISOLATION_FORBIDDEN_TARGETS ?? "[]",
    );
    const fixtureProxy = process.env.CODEX_INFERENCE_FIXTURE_PROXY_URL;
    const fixtureTarget = process.env.CODEX_INFERENCE_FIXTURE_TARGET;

    assert.ok(transportContainer, "set CODEX_TRANSPORT_CONTAINER");
    assert.ok(executorContainer, "set CODEX_EXECUTOR_CONTAINER");
    assert.ok(
      forbiddenTargets.length >= 4,
      "provide fake Core/n8n/DB/metadata targets",
    );
    assert.deepEqual(
      new Set(forbiddenTargets.map((target) => target.name)),
      new Set(["core", "n8n", "postgres", "metadata"]),
      "instrument each forbidden service class",
    );
    await preflightFakeListeners(forbiddenTargets);
    assert.ok(fixtureProxy, "set CODEX_INFERENCE_FIXTURE_PROXY_URL");
    assert.ok(fixtureTarget, "set CODEX_INFERENCE_FIXTURE_TARGET");

    function docker(args) {
      return execFileSync("docker", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }).trim();
    }

    function inspect(container, format) {
      return JSON.parse(docker(["inspect", "--format", format, container]));
    }

    const executorEnv = inspect(executorContainer, "{{json .Config.Env}}");
    const forbiddenEnv = [
      "CODEX_WORKER_DISPATCH_KEY=",
      "CODEX_WORKER_CALLBACK_KEY=",
      "DATABASE_URL=",
      "CORE_API_KEY=",
      "PGHOST=",
      "CODEX_N8N_BASE_URL=",
      "CODEX_WORKER_SPOOL_DIR=",
      "CODEX_WORKER_BIND_ADDRESS=",
      "CODEX_EXECUTOR_BASE_URL=",
    ];
    assert.equal(
      forbiddenEnv.some((prefix) =>
        executorEnv.some((entry) => entry.startsWith(prefix)),
      ),
      false,
      "executor must not receive transport or Core credentials",
    );
    const transportEnv = inspect(transportContainer, "{{json .Config.Env}}");
    assert.equal(
      transportEnv.some(
        (entry) =>
          entry.startsWith("CODEX_API_KEY=") ||
          entry.startsWith("OPENAI_API_KEY=") ||
          entry.startsWith("DATABASE_URL=") ||
          entry.startsWith("PGHOST="),
      ),
      false,
      "transport must not receive provider credentials",
    );

    const executorMounts = inspect(executorContainer, "{{json .Mounts}}");
    assert.equal(
      executorMounts.some((mount) =>
        [
          "/var/lib/codex-worker",
          "/app",
          "/root/.codex",
          "/home/node/.codex",
          "/workspace",
        ].includes(mount.Destination),
      ),
      false,
      "executor must not mount spool, host Codex config, or the repository",
    );
    assert.equal(
      executorMounts.some(
        (mount) =>
          mount.Type === "tmpfs" &&
          mount.Destination === "/tmp/rovelle-codex-worker",
      ),
      true,
      "executor must receive a private tmpfs workspace",
    );
    const transportMounts = inspect(transportContainer, "{{json .Mounts}}");
    assert.equal(
      transportMounts.filter(
        (mount) =>
          mount.Type === "volume" &&
          mount.Destination === "/var/lib/codex-worker",
      ).length,
      1,
      "only transport may mount the durable spool",
    );
    assert.equal(
      transportMounts.some(
        (mount) =>
          mount.Type === "bind" &&
          ["/app", "/workspace", "/root/.codex", "/home/node/.codex"].includes(
            mount.Destination,
          ),
      ),
      false,
      "transport must not mount the repository or host Codex config",
    );
    const executorNetworks = inspect(
      executorContainer,
      "{{json .NetworkSettings.Networks}}",
    );
    const forbiddenNetworks = JSON.parse(
      process.env.CODEX_ISOLATION_FORBIDDEN_NETWORKS ?? "[]",
    );
    assert.ok(
      forbiddenNetworks.length >= 2,
      "provide the existing Core and n8n network names",
    );
    assert.equal(
      forbiddenNetworks.some((network) =>
        Object.hasOwn(executorNetworks, network),
      ),
      false,
      "executor must not join Core or n8n networks",
    );

    const absentPaths = [
      "/var/lib/codex-worker",
      "/root/.codex",
      "/home/node/.codex",
      "/app/dist/main.js",
      "/app/node_modules/@prisma",
      "/app/node_modules/pg",
    ];
    const absenceScript = `
    const fs = require('node:fs');
    const paths = JSON.parse(process.argv[1]);
    const present = paths.filter((path) => fs.existsSync(path));
    if (present.length) { console.error(JSON.stringify(present)); process.exit(1); }
  `;
    docker([
      "exec",
      executorContainer,
      "node",
      "-e",
      absenceScript,
      JSON.stringify(absentPaths),
    ]);
    const runtimePresenceScript = `
    const fs = require('node:fs');
    const packagePath = '/app/node_modules/@openai/codex-sdk';
    if (!fs.existsSync(packagePath)) { console.error('executor SDK is absent'); process.exit(1); }
    if (!fs.existsSync('/app/node_modules/@nestjs/common')) { console.error('shared worker validation runtime is absent'); process.exit(1); }
  `;
    docker(["exec", executorContainer, "node", "-e", runtimePresenceScript]);
    const transportSdkAbsenceScript = `
    const fs = require('node:fs');
    if (fs.existsSync('/app/node_modules/@openai/codex-sdk')) {
      console.error('transport must not contain the SDK runtime'); process.exit(1);
    }
    if (!fs.existsSync('/app/node_modules/@nestjs/common')) {
      console.error('shared worker validation runtime is absent'); process.exit(1);
    }
  `;
    docker([
      "exec",
      transportContainer,
      "node",
      "-e",
      transportSdkAbsenceScript,
    ]);

    const forbidden = forbiddenTargets.map((target) => {
      const url = new URL(target.url);
      assert.equal(
        isIP(url.hostname),
        4,
        `${target.name} must use an instrumented IP`,
      );
      assert.equal(url.protocol, "http:");
      return { name: target.name, url: url.href };
    });
    const deniedScript = `
    const targets = JSON.parse(process.argv[1]);
    (async () => {
      const results = await Promise.all(targets.map(async (target) => {
        try {
          const response = await fetch(target.url, { signal: AbortSignal.timeout(1500) });
          await response.arrayBuffer();
          return { name: target.name, connected: true, status: response.status };
        } catch { return { name: target.name, connected: false }; }
      }));
      const connected = results.filter((result) => result.connected);
      if (connected.length) { console.error(JSON.stringify(connected)); process.exit(1); }
    })().catch(() => process.exit(1));
  `;
    docker([
      "exec",
      executorContainer,
      "node",
      "-e",
      deniedScript,
      JSON.stringify(forbidden),
    ]);

    const proxy = new URL(fixtureProxy);
    const target = new URL(fixtureTarget);
    assert.equal(proxy.protocol, "http:");
    assert.equal(
      isIP(proxy.hostname),
      4,
      "use the reserved proxy bridge address",
    );
    assert.equal(target.protocol, "http:");
    assert.match(target.hostname, /\.test$/);
    const proxyScript = `
    const http = require('node:http');
    const proxy = new URL(process.argv[1]);
    const target = new URL(process.argv[2]);
    const request = http.request(proxy, {
      method: 'GET',
      path: target.href,
      headers: { host: target.host },
      timeout: 3000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200 || Buffer.concat(chunks).toString() !== 'codex-isolation-fixture-v1') {
          process.exit(1);
        }
      });
    });
    request.on('error', () => process.exit(1));
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.end();
  `;
    docker([
      "exec",
      executorContainer,
      "node",
      "-e",
      proxyScript,
      fixtureProxy,
      fixtureTarget,
    ]);

    const listenerCountersUrl =
      process.env.CODEX_ISOLATION_LISTENER_COUNTERS_URL;
    const providerCallsUrl = process.env.CODEX_PROVIDER_CALL_COUNTER_URL;
    assert.ok(
      listenerCountersUrl,
      "set instrumented fake-listener counter URL",
    );
    assert.ok(providerCallsUrl, "set fixture proxy provider-call counter URL");
    const listenerResponse = await fetch(listenerCountersUrl, {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(listenerResponse.status, 200);
    const listenerCounters = await listenerResponse.json();
    for (const name of ["core", "n8n", "postgres", "metadata"]) {
      assert.equal(
        listenerCounters[name],
        0,
        `${name} listener received a request`,
      );
    }
    const providerResponse = await fetch(providerCallsUrl, {
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(providerResponse.status, 200);
    const providerCounters = await providerResponse.json();
    assert.equal(
      providerCounters.providerCalls,
      0,
      "test must never call a provider",
    );

    await t.test("executor remains private and has no published ports", () => {
      const ports = inspect(
        executorContainer,
        "{{json .NetworkSettings.Ports}}",
      );
      assert.ok(
        ports === null ||
          Object.values(ports).every(
            (bindings) => !bindings || bindings.length === 0,
          ),
        "executor must not publish a host port",
      );
    });
  },
);
