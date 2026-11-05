# Offline checks of nixos/runner.nix. A stand-in runner package replaces the real
# one for everything that needs a job, because nothing here reaches GitHub.
{
  nixpkgs,
  module,
  pkgs,
}:
let
  inherit (pkgs) lib;

  repository = "your-org/your-repo-qlander";
  # The first runner of a host with the evaluation host's default name.
  runnerName = "nixos-qlander-1";

  # The Bun the tick pins, from the same file the tick reads.
  bunPin = lib.splitString " " (lib.trim (builtins.readFile ../template/.github/bun-release.txt));
  bunVersion = builtins.elemAt bunPin 0;
  bunAsset = builtins.elemAt bunPin 1;
  bunSum = builtins.elemAt bunPin 2;
  bunZip = pkgs.fetchurl {
    url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${bunAsset}";
    sha256 = bunSum;
  };
  bunDir = lib.removeSuffix ".zip" bunAsset;

  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../schema
      ../scripts/build-release.ts
      ../src
    ];
  };

  # The bundle, built the way a release builds it.
  bundleDir = pkgs.runCommand "qlander-bundle" { nativeBuildInputs = [ pkgs.unzip ]; } ''
    unzip -q ${bunZip} -d bun
    cp -r ${source} repo
    chmod -R u+w repo
    cd repo
    ${pkgs.stdenv.cc.bintools.dynamicLinker} ../bun/${bunDir}/bun scripts/build-release.ts --out "$out"
  '';
  bundleVersion = (lib.importJSON ../package.json).version;
  bundle = "${bundleDir}/qlander-${bundleVersion}.js";

  # The template config, moved to self-hosted-kill as a real deployment would.
  selfHostedConfig =
    {
      hostKill ? 6,
      jobTimeout ? 5,
      fence ? true,
      repo ? repository,
      runsOn ? "qlander",
    }:
    pkgs.runCommand "qlander.yml" { nativeBuildInputs = [ pkgs.yq-go ]; } ''
      yq '
        .control.repo = "${repo}" |
        .runner.mode = "self-hosted-kill" |
        .runner.hostKillMinutes = ${toString hostKill} |
        .runner.jobTimeoutMinutes = ${toString jobTimeout} |
        .runner.epochFence = ${lib.boolToString fence} |
        .runner.takeoverGraceMinutes = 2 |
        .runner.runsOn = ["${runsOn}"]
      ' ${../template/qlander.yml} >"$out"
    '';

  # What the job-less part of a host needs in order to evaluate.
  host = extra: {
    imports = [
      module
      extra
    ];
    boot.loader.grub.enable = false;
    fileSystems."/" = {
      device = "none";
      fsType = "tmpfs";
    };
    system.stateVersion = "26.05";
  };
  evalHost =
    extra:
    nixpkgs.lib.nixosSystem {
      inherit (pkgs.stdenv.hostPlatform) system;
      modules = [ (host extra) ];
    };
  runnerConfig = {
    services.qlander-runner = {
      enable = true;
      inherit repository;
      tokenFile = "/run/keys/runner-token";
      hostKillMinutes = 6;
      qlanderConfig = selfHostedConfig { };
    };
  };

  # The system check for a config, on its own, to build or to fail to build.
  configCheckFor =
    {
      qlanderConfig,
      hostKillMinutes ? 6,
    }:
    lib.findFirst (d: d.name == "qlander-runner-config-check") (throw "no config check") (
      evalHost {
        imports = [ runnerConfig ];
        services.qlander-runner = {
          qlanderConfig = lib.mkForce qlanderConfig;
          hostKillMinutes = lib.mkForce hostKillMinutes;
        };
      }
    ).config.system.checks;

  refusedConfig =
    name: args:
    pkgs.testers.testBuildFailure (configCheckFor args // { name = "refused-${name}"; });

  # Whether a host configuration is refused at evaluation.
  refused =
    extra:
    !(builtins.tryEval
      (evalHost {
        imports = [
          runnerConfig
          extra
        ];
      }).config.system.build.toplevel.drvPath
    ).success;

  # Stands in for the real runner package. `configure` records its arguments
  # without the token. `run` waits for a job file, and hands it to a child
  # process, as the real listener hands a job to Runner.Worker.
  fakeRunner = fakeRunnerBuild // {
    # The nixpkgs option calls this to choose Node runtimes.
    override = _: fakeRunnerBuild;
  };
  fakeRunnerBuild = pkgs.runCommand "fake-github-runner" { } ''
    mkdir -p $out/bin
    cat >$out/bin/Runner.Listener <<'SCRIPT'
    #!${pkgs.runtimeShell}
    if [ "$1" = configure ]; then
      shift
      out=""
      while [ $# -gt 0 ]; do
        if [ "$1" = --pat ] || [ "$1" = --token ]; then out="$out $1 <hidden>"; shift; else out="$out $1"; fi
        shift
      done
      echo "fake-configure:$out"
      exit 0
    fi
    echo "fake-listener idle"
    # Idle without child processes, as the real listener does: the watcher
    # counts any other process as a job. `read -t` on a silent FIFO is a builtin sleep.
    mkfifo "$HOME/idle"
    exec 3<>"$HOME/idle"
    while [ ! -e /run/fake-github/job ]; do read -r -t 0.2 -u 3 || :; done
    @worker@
    exit 0
    SCRIPT
    cat >$out/bin/Runner.Worker <<'SCRIPT'
    #!${pkgs.runtimeShell}
    . /run/fake-github/env
    export GITHUB_REF GITHUB_WORKFLOW_REF
    read -r uptime _ </proc/uptime
    echo "fake-worker-start $JOB $uptime"
    # A failed hook only fails the job: an `if: always()` step still runs. So
    # only the hook's kill can stop the step below.
    bash -e "$ACTIONS_RUNNER_HOOK_JOB_STARTED" || echo "fake-worker-hook-failed $JOB"
    echo "fake-worker-steps $JOB"
    bash /run/fake-github/job
    echo "fake-worker-end $JOB $?"
    SCRIPT
    substituteInPlace $out/bin/Runner.Listener --replace-fail @worker@ $out/bin/Runner.Worker
    chmod +x $out/bin/*
  '';

  # A stuck tick: it ignores the polite signals, keeps a detached child, and
  # keeps a stopped child, which is the frozen process the contract is about.
  stuckJob = pkgs.writeShellScript "stuck-job" ''
    trap "" INT TERM HUP
    touch "$HOME/leftover" "$RUNNER_ROOT/leftover"
    ${pkgs.util-linux}/bin/setsid bash -c 'trap "" INT TERM HUP; while :; do sleep 1; done; : stuck-job-marker' &
    bash -c 'kill -STOP $$; : stuck-job-marker' &
    bash -c 'trap "" INT TERM HUP; while :; do sleep 1; done; : stuck-job-marker'
  '';

  # The tick's commands for getting Bun and the bundle, run in the job's
  # sandbox, on the service's path only. A local copy replaces the downloads.
  bunJob = pkgs.writeShellScript "bun-job" ''
    set -euo pipefail
    command -v curl unzip sha256sum mktemp
    if [ -S /nix/var/nix/daemon-socket/socket ]; then
      echo "the job can reach the Nix daemon"
      exit 1
    fi
    dir="$(mktemp -d)"
    cp ${bunZip} "$dir/${bunAsset}"
    (cd "$dir" && echo "${bunSum}  ${bunAsset}" | sha256sum -c -)
    unzip -q "$dir/${bunAsset}" -d "$dir"
    bun="$dir/${bunDir}/bun"
    cp ${bundle} "$dir/bundle.js"
    (cd "$dir" && echo "$(sha256sum ${bundle} | cut -d" " -f1)  bundle.js" | sha256sum -c -)
    "$bun" --version | grep -Fx ${bunVersion}
    "$bun" "$dir/bundle.js" version | grep -F ${bundleVersion}
    "$bun" "$dir/bundle.js" validate --config ${../template}/qlander.yml
    "$bun" "$dir/bundle.js" render --check --config ${../template}/qlander.yml
    echo bun-job-passed
  '';

  markerJob = pkgs.writeShellScript "marker-job" ''
    echo marker-job-ran
  '';

  runner-vm = pkgs.testers.runNixOSTest {
    name = "qlander-runner";
    # One minute is the shortest bound the option can express.
    nodes.machine = {
      imports = [ module ];
      # The test framework turns this off; the module requires a clock source.
      services.timesyncd.enable = lib.mkForce true;
      services.qlander-runner = {
        enable = true;
        inherit repository;
        tokenFile = "/run/keys/runner-token";
        hostKillMinutes = 1;
        qlanderConfig = selfHostedConfig {
          hostKill = 1;
          jobTimeout = 1;
        };
        package = fakeRunner;
        name = "pool";
      };
      systemd.services.github-runner-pool-1.serviceConfig.RestartSec = lib.mkForce "5s";
      systemd.tmpfiles.settings.fake-github."/run/fake-github".d.mode = "0755";
      systemd.tmpfiles.settings.keys."/run/keys/runner-token".f = {
        mode = "0600";
        argument = "not-a-real-token";
      };
    };

    # The real runner package, with no GitHub to reach.
    nodes.real = {
      imports = [ module ];
      # The test framework turns this off; the module requires a clock source.
      services.timesyncd.enable = lib.mkForce true;
      services.qlander-runner = {
        enable = true;
        inherit repository;
        tokenFile = "/run/keys/runner-token";
        hostKillMinutes = 6;
        qlanderConfig = selfHostedConfig { };
        name = "pool";
      };
      systemd.tmpfiles.settings.keys."/run/keys/runner-token".f = {
        mode = "0600";
        argument = "github_pat_not_a_real_token";
      };
      virtualisation.memorySize = 2048;
    };

    testScript = ''
      runner = "github-runner-pool-1.service"
      watcher = "runner-kill-pool-1.service"
      good_ref = "${repository}/.github/workflows/tick.yml@refs/heads/main"


      def show(prop):
          return machine.succeed(f"systemctl show -P {prop} {runner}").strip()


      def start_job(job, script, ref=good_ref, workflow_branch="refs/heads/main"):
          """Hand the stand-in listener a job. Returns the uptime its worker started at."""
          machine.succeed(
              f"printf 'JOB=%s\\nGITHUB_REF=%s\\nGITHUB_WORKFLOW_REF=%s\\n' {job} {workflow_branch} {ref} >/run/fake-github/env;"
              f"cp {script} /run/fake-github/job.tmp; mv /run/fake-github/job.tmp /run/fake-github/job"
          )
          line = machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep 'fake-worker-start {job} '")
          machine.succeed("rm /run/fake-github/job")
          return float(line.strip().split()[-1])


      def journal_has(pattern):
          return machine.execute(f"journalctl -u {runner} -o cat | grep -q '{pattern}'")[0] == 0


      start_all()

      with subtest("the units are configured as the contract needs"):
          machine.wait_for_unit(watcher)
          machine.wait_until_succeeds(f"systemctl is-active {runner}")
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -q 'fake-listener idle'")
          assert show("Restart") == "always", show("Restart")
          assert show("KillSignal") == "9", show("KillSignal")
          assert show("KillMode") == "control-group", show("KillMode")
          assert show("DynamicUser") == "yes", show("DynamicUser")
          assert show("NoNewPrivileges") == "yes", show("NoNewPrivileges")
          assert show("Delegate") == "no", show("Delegate")
          assert watcher in show("BindsTo"), show("BindsTo")
          assert watcher in show("After"), show("After")
          env = show("Environment")
          assert "ACTIONS_RUNNER_HOOK_JOB_STARTED=/nix/store/" in env, env
          configure = machine.succeed(f"journalctl -u {runner} -o cat | grep fake-configure")
          for want in ["--url https://github.com/${repository} ", "--labels qlander ", "--ephemeral", "--replace", "--pat <hidden>", "--name pool-1"]:
              assert want in configure, f"{want} not in {configure}"
          assert "not-a-real-token" not in machine.succeed(f"journalctl -u {runner} -o cat; systemctl cat {runner}")
          machine.succeed("systemctl is-enabled systemd-timesyncd.service")
          machine.succeed("test -e /run/current-system/sw/share/nix-ld/lib/ld.so")

      with subtest("an idle runner is not killed: the bound counts from the job's start"):
          before = show("MainPID")
          machine.sleep(70)
          assert show("MainPID") == before, "the idle runner was replaced"
          assert not journal_has("job started")

      with subtest("the real Bun and bundle run in the job's sandbox"):
          start_job("bun", "${bunJob}")
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -q 'fake-worker-end bun '", timeout=120)
          print(machine.succeed(f"journalctl -u {runner} -o cat | grep -A30 'fake-worker-steps bun' | head -40"))
          assert journal_has("bun-job-passed"), "the Bun job did not finish"
          assert journal_has("fake-worker-end bun 0"), "the Bun job failed"

      with subtest("a job from another workflow or branch is refused before its first step"):
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -c 'fake-listener idle' | grep -qx 2")
          pid = show("MainPID")
          start_job("wrongref", "${markerJob}", ref="${repository}/.github/workflows/other.yml@refs/heads/main")
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -q 'qlander: refusing'")
          machine.wait_until_succeeds(f"systemctl show -P MainPID {runner} | grep -vx '{pid}'")
          assert not journal_has("marker-job-ran"), "a refused job ran a step"

          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -c 'fake-listener idle' | grep -qx 3")
          start_job("wrongbranch", "${markerJob}", ref="${repository}/.github/workflows/tick.yml@refs/heads/dev", workflow_branch="refs/heads/dev")
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -c 'qlander: refusing' | grep -qx 2")
          assert not journal_has("marker-job-ran"), "a refused job ran a step"

      with subtest("a stuck job is killed at the bound, including what it hid"):
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -c 'fake-listener idle' | grep -qx 4")
          pid = show("MainPID")
          started = start_job("stuck", "${stuckJob}")
          machine.wait_until_succeeds("pgrep -f stuck-job-marke[r]")
          machine.sleep(2)
          # Three stuck processes, one of them stopped and one in its own session.
          assert len(machine.succeed("pgrep -f stuck-job-marke[r]").split()) == 3
          assert " T" in machine.succeed("ps -eo stat,args | grep '[s]tuck-job-marker' | sed 's/^/ /'")
          # Timed in the guest, to a tenth of a second, without trusting the watcher's log.
          machine.succeed("until ! pgrep -f stuck-job-marke[r] >/dev/null; do sleep 0.1; done; cut -d' ' -f1 /proc/uptime >/tmp/gone", timeout=120)
          gone = float(machine.succeed("cat /tmp/gone"))
          elapsed = gone - started
          print(f"job started at {started}, gone at {gone}: {elapsed:.1f}s")
          assert 58 <= elapsed <= 63, f"killed after {elapsed} seconds, not 60"
          machine.succeed(f"journalctl -u {watcher} -o cat | grep -q 'kill bound reached'")

      with subtest("after the kill the runner comes back clean"):
          machine.wait_until_succeeds(f"systemctl show -P MainPID {runner} | grep -vxE '0|{pid}'")
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -c 'fake-listener idle' | grep -qx 5")
          machine.fail("test -e /run/github-runner/pool-1/leftover")
          machine.fail("test -e /var/lib/private/github-runner/pool-1/leftover")

      with subtest("stopping the watcher kills the job at once, even a stuck one"):
          start_job("orphan", "${stuckJob}")
          machine.wait_until_succeeds("pgrep -f stuck-job-marke[r]")
          machine.sleep(2)
          machine.succeed(f"systemctl stop {watcher}")
          machine.succeed("timeout 5 sh -c 'until ! pgrep -f stuck-job-marke[r] >/dev/null; do sleep 0.1; done'")
          machine.fail(f"systemctl is-active {runner}")
          machine.succeed(f"systemctl start {runner}")
          machine.succeed(f"systemctl is-active {watcher}")
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -c 'fake-listener idle' | grep -qx 6")

      with subtest("a watcher that dies takes the job with it, and the pool recovers"):
          start_job("crash", "${stuckJob}")
          machine.wait_until_succeeds("pgrep -f stuck-job-marke[r]")
          machine.sleep(2)
          machine.succeed(f"systemctl kill --signal=SIGKILL {watcher}")
          machine.succeed("timeout 5 sh -c 'until ! pgrep -f stuck-job-marke[r] >/dev/null; do sleep 0.1; done'")
          machine.wait_until_succeeds(f"systemctl is-active {watcher}")
          machine.wait_until_succeeds(f"systemctl is-active {runner}")
          machine.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -c 'fake-listener idle' | grep -qx 7")

      with subtest("the real runner binary starts under this unit and gets as far as GitHub's API"):
          real.wait_for_unit("runner-kill-pool-1.service")
          real.wait_until_succeeds(f"journalctl -u {runner} -o cat | grep -q 'api.github.com'", timeout=120)
          output = real.succeed(f"journalctl -u {runner} -o cat")
          print(output)
          assert "github_pat_not_a_real_token" not in output
          assert real.succeed(f"systemctl show -P Restart {runner}").strip() == "always"
          real.succeed(f"systemctl cat {runner} | grep -q 'Runner.Listener run --startuptype service'")
    '';
  };

  # What the module refuses when a host is evaluated.
  refusals =
    let
      cases = {
        "a token file in the Nix store" = {
          services.qlander-runner.tokenFile = lib.mkForce "/nix/store/00000000000000000000000000000000-token";
        };
        "a repository that is not owner/name" = {
          services.qlander-runner.repository = lib.mkForce "your-org";
        };
        "a kill bound of zero" = {
          services.qlander-runner.hostKillMinutes = lib.mkForce 0;
        };
        "no NTP" = {
          services.timesyncd.enable = false;
        };
        "a kill mode that spares the job" = {
          services.github-runners.${runnerName}.serviceOverrides.KillMode = lib.mkOverride 10 "process";
        };
        "a static runner user" = {
          services.github-runners.${runnerName}.user = "root";
        };
      };
      accepted = lib.attrNames (lib.filterAttrs (_: extra: !refused extra) cases);
    in
    assert lib.assertMsg (accepted == [ ]) "accepted: ${lib.concatStringsSep ", " accepted}";
    assert lib.assertMsg (!refused { }) "the valid configuration was refused";
    # Neither the bound nor the config it is checked against has a default.
    assert lib.assertMsg (
      lib.all
        (
          missing:
          !(builtins.tryEval
            (evalHost {
              services.qlander-runner = removeAttrs runnerConfig.services.qlander-runner [ missing ];
            }).config.system.build.toplevel.drvPath
          ).success
        )
        [
          "hostKillMinutes"
          "qlanderConfig"
        ]
    ) "a required option has a default";
    pkgs.runCommand "qlander-runner-refusals" { } "touch $out";

  # A config the module accepts is one the real `validate` accepts too.
  config-check-accepts =
    let
      config = selfHostedConfig { };
    in
    pkgs.runCommand "qlander-runner-config-accepts"
      {
        nativeBuildInputs = [ pkgs.unzip ];
        check = configCheckFor { qlanderConfig = config; };
      }
      ''
        unzip -q ${bunZip} -d bun
        mkdir control
        cp ${config} control/qlander.yml
        ${pkgs.stdenv.cc.bintools.dynamicLinker} bun/${bunDir}/bun ${bundle} validate --config control/qlander.yml
        touch "$out"
      '';
in
{
  inherit runner-vm refusals config-check-accepts;

  config-check-refuses-a-later-kill = refusedConfig "later-kill" {
    qlanderConfig = selfHostedConfig { hostKill = 5; };
  };
  config-check-refuses-another-repo = refusedConfig "another-repo" {
    qlanderConfig = selfHostedConfig { repo = "your-org/another-qlander"; };
  };
  config-check-refuses-a-missing-label = refusedConfig "label" {
    qlanderConfig = selfHostedConfig { runsOn = "some-other-pool"; };
  };
  config-check-refuses-no-fence = refusedConfig "no-fence" {
    qlanderConfig = selfHostedConfig { fence = false; };
  };
  config-check-refuses-hosted-mode = refusedConfig "hosted" {
    qlanderConfig = ../template/qlander.yml;
  };
  config-check-refuses-a-kill-before-the-timeout = refusedConfig "early-kill" {
    qlanderConfig = selfHostedConfig { };
    hostKillMinutes = 4;
  };
}
