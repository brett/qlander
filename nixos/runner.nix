# A self-hosted runner pool for one qlander control repo, for
# runner.mode: self-hosted-kill (docs/deployment.md, section 3.2).
#
# Each runner is the nixpkgs github-runner service, ephemeral and registered to
# one repo. That service is the job's container: its cgroup holds every process
# of the job, and each job starts from a clean state and work directory.
#
# A root watcher unit, one per runner, enforces runner.hostKillMinutes. It arms
# when any process other than the listener appears in the runner's cgroup, and
# at the limit it kills the whole cgroup with cgroup.kill. The job can't reach
# the watcher, and it can't leave the cgroup. The runner is bound to the
# watcher, so if the watcher stops for any reason the job dies with it.
#
# What this can't do: the watcher shares a kernel with the job, so a pause of
# the whole machine pauses both. docs/getting-started.md, "Running on NixOS",
# says what covers that.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.qlander-runner;

  names = map (i: "${cfg.name}-${toString i}") (lib.range 1 cfg.instances);
  runnerUnit = name: "github-runner-${name}";
  watcherUnit = name: "runner-kill-${name}";

  # The runner runs this before the job's first step. A repo-scoped runner can
  # be claimed by any workflow in the repo, on any branch, and GitHub's
  # per-workflow restriction exists only for organisation runner groups. A
  # non-zero exit would only fail the job, and later `if: always()` steps would
  # still run, so a refusal kills every process of this runner's user.
  # The .sh suffix matters: the runner picks the interpreter from it.
  jobStartedHook = pkgs.writeShellScript "job-started-hook.sh" ''
    trap "" INT TERM HUP
    if [ "''${GITHUB_WORKFLOW_REF:-}" = ${lib.escapeShellArg "${cfg.repository}/.github/workflows/tick.yml@refs/heads/main"} ] \
      && [ "''${GITHUB_REF:-}" = refs/heads/main ]; then
      exit 0
    fi
    echo "qlander: refusing ref=''${GITHUB_REF:-} workflow=''${GITHUB_WORKFLOW_REF:-}"
    kill -KILL -1
    exit 1
  '';

  # /proc/uptime counts time the machine spent suspended, so a machine that
  # wakes past the limit kills at once. Whatever the watcher can't observe counts
  # against the job: if systemctl fails the listener is unknown, so any process
  # arms the kill, and only a cgroup seen empty or gone disarms it.
  watcherScript =
    name:
    pkgs.writeShellScript "${watcherUnit name}" ''
      set -u
      unit=${lib.escapeShellArg "${runnerUnit name}.service"}
      limit=${toString (cfg.hostKillMinutes * 60)}
      cgroup=/system.slice/$unit
      seen=""
      armed=""
      echo "kill bound for $unit: $limit seconds after a job starts"
      while :; do
        main=0
        state=unknown
        while IFS="=" read -r key value; do
          case "$key" in
            MainPID) main=$value ;;
            SubState) state=$value ;;
            ControlGroup) if [ -n "$value" ]; then cgroup=$value; fi ;;
          esac
        done < <(timeout -k 1 5 systemctl show "$unit" -p MainPID -p SubState -p ControlGroup)

        dir=/sys/fs/cgroup$cgroup
        readable=yes
        procs=$(cat "$dir/cgroup.procs" 2>/dev/null) || readable=no

        if [ ! -e "$dir" ] || { [ "$readable" = yes ] && [ -z "$procs" ]; }; then
          seen=""
          armed=""
        else
          read -r now _ </proc/uptime
          now=''${now%.*}
          # ExecStartPre registers the runner; no job can start until it is done.
          # A process must last two polls, because the real listener's wrapper
          # runs a short-lived mkdir as it starts. The bound still counts from
          # the first poll that saw it.
          others=""
          if [ "$readable" = no ]; then
            others=unreadable
          elif [ "$state" != start-pre ]; then
            for pid in $procs; do
              if [ "$pid" != "$main" ]; then others=$pid; fi
            done
          fi
          if [ -z "$others" ]; then
            seen=""
          elif [ -z "$seen" ]; then
            seen=$now
          elif [ -z "$armed" ]; then
            armed=$seen
            echo "job started (pid $others): killing it $limit seconds after uptime $armed"
          fi
          if [ -n "$armed" ] && [ $((now - armed)) -ge "$limit" ]; then
            echo "kill bound reached after $((now - armed)) seconds: killing $unit"
            if ! echo 1 >"$dir/cgroup.kill"; then
              timeout -k 1 5 systemctl kill --kill-whom=all --signal=SIGKILL "$unit"
            fi
          fi
        fi
        sleep 1
      done
    '';

  # Built with the system, so a host that disagrees with the config it names
  # fails to build. The comparison is a build step and not an evaluation step,
  # because reading YAML during evaluation would need import-from-derivation.
  configCheck =
    pkgs.runCommand "qlander-runner-config-check" { nativeBuildInputs = [ pkgs.yq-go ]; }
      ''
        config=${cfg.qlanderConfig}
        fail() { echo "services.qlander-runner disagrees with qlander.yml: $1" >&2; exit 1; }
        get() { yq -r "$1" "$config"; }

        [ "$(get .control.repo)" = ${lib.escapeShellArg cfg.repository} ] \
          || fail "control.repo is $(get .control.repo), but repository is ${cfg.repository}"
        [ "$(get .runner.mode)" = self-hosted-kill ] \
          || fail "runner.mode is $(get .runner.mode), not self-hosted-kill"
        [ "$(get .runner.epochFence)" = true ] \
          || fail "runner.epochFence must be true: this host's kill can't cover a pause of the whole machine"

        kill=${toString cfg.hostKillMinutes}
        [ "$kill" -le "$(get .runner.hostKillMinutes)" ] \
          || fail "hostKillMinutes is $kill, later than runner.hostKillMinutes $(get .runner.hostKillMinutes), so a successor could take over from a live job"
        [ "$kill" -ge "$(get .runner.jobTimeoutMinutes)" ] \
          || fail "hostKillMinutes is $kill, sooner than runner.jobTimeoutMinutes $(get .runner.jobTimeoutMinutes)"

        known=${
          lib.escapeShellArg (
            lib.toLower (lib.concatStringsSep " " (cfg.labels ++ [ "self-hosted" "linux" "x64" ]))
          )
        }
        for label in $(get '.runner.runsOn | .. | select(tag == "!!str")'); do
          case " $known " in
            *" $(echo "$label" | tr '[:upper:]' '[:lower:]') "*) ;;
            *) fail "runner.runsOn has $label, which these runners don't carry" ;;
          esac
        done
        touch "$out"
      '';

  # The kill reaches every process only with these: an unprivileged user that
  # can't leave the cgroup, one cgroup, and a stop that spares nothing.
  requiredUnitSettings = {
    DynamicUser = true;
    NoNewPrivileges = true;
    ProtectControlGroups = true;
    Delegate = false;
    KillMode = "control-group";
    KillSignal = "SIGKILL";
    Restart = "always";
  };
in
{
  options.services.qlander-runner = {
    enable = lib.mkEnableOption "a self-hosted runner pool for one qlander control repo";

    repository = lib.mkOption {
      type = lib.types.strMatching "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
      example = "your-org/your-repo-qlander";
      description = ''
        The control repo, as `owner/name`, spelled as GitHub spells it. The
        runners register to this repo only, and accept only its
        `.github/workflows/tick.yml` on `main`.
      '';
    };

    tokenFile = lib.mkOption {
      type = lib.types.externalPath;
      example = "/run/secrets/qlander-runner-token";
      description = ''
        A file, outside the Nix store and readable by root, holding a
        fine-grained personal access token limited to the control repo, with the
        repository permission Administration: write. A registration token
        won't do: an ephemeral runner registers again for every job, and those
        tokens expire after an hour. The job can't read this file.
      '';
    };

    hostKillMinutes = lib.mkOption {
      type = lib.types.ints.positive;
      example = 6;
      description = ''
        Kill a job this long after it starts. Set it to `runner.hostKillMinutes`
        in `qlander.yml`; there is no default, so a host can't get a bound
        nobody chose. A later value than the config's is unsafe, because a
        successor could take over from a job that is still alive. So when you
        change the two: to raise it, change `qlander.yml` first; to lower
        it, change this first.
      '';
    };

    qlanderConfig = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "inputs.control-repo + \"/qlander.yml\"";
      description = ''
        The control repo's `qlander.yml`, copied to the Nix store and
        checked when the system builds. The build fails unless the file has
        this `repository`, `runner.mode: self-hosted-kill` and
        `runner.epochFence: true`, unless `hostKillMinutes` is between
        `runner.jobTimeoutMinutes` and `runner.hostKillMinutes`, and unless
        these runners carry every label in `runner.runsOn`. It checks the copy
        the host was built with: changing the config later needs a rebuild to
        be checked.
      '';
    };

    labels = lib.mkOption {
      type = lib.types.nonEmptyListOf lib.types.nonEmptyStr;
      default = [ "qlander" ];
      description = "Runner labels, added to GitHub's defaults. They must cover `runner.runsOn`.";
    };

    instances = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1;
      description = ''
        How many runners, each with one job at a time and its own watcher. With
        one, the queue and release jobs run one after the other.
      '';
    };

    name = lib.mkOption {
      type = lib.types.strMatching "[A-Za-z0-9_-]+";
      default = "${config.networking.hostName}-qlander";
      defaultText = lib.literalExpression ''"''${config.networking.hostName}-qlander"'';
      description = "Prefix of the runner names, which end in `-1`, `-2` and so on. Unique in the repo.";
    };

    package = lib.mkPackageOption pkgs "github-runner" { };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          config.services.timesyncd.enable
          || config.services.chrony.enable
          || config.services.ntpd-rs.enable
          || config.services.ntp.enable
          || config.services.openntpd.enable;
        message = "services.qlander-runner: the runner contract needs the host clock kept by NTP.";
      }
    ]
    ++ map (name: {
      assertion =
        let
          unit = config.systemd.services.${runnerUnit name}.serviceConfig;
        in
        !(unit ? User)
        && lib.all (key: (unit.${key} or null) == requiredUnitSettings.${key}) (lib.attrNames requiredUnitSettings);
      message = "services.qlander-runner: runner ${name} overrides a setting the kill bound relies on; it needs no User and ${builtins.toJSON requiredUnitSettings}.";
    }) names;

    system.checks = [ configCheck ];

    # The tick runs a downloaded, dynamically linked Bun.
    programs.nix-ld.enable = true;

    services.github-runners = lib.genAttrs names (name: {
      enable = true;
      inherit name;
      inherit (cfg) package tokenFile;
      url = "https://github.com/${cfg.repository}";
      tokenType = "access";
      extraLabels = cfg.labels;
      ephemeral = true;
      replace = true;
      # The tick's own tools (the rest are on the service's path already).
      extraPackages = [
        pkgs.curl
        pkgs.unzip
      ];
      extraEnvironment.ACTIONS_RUNNER_HOOK_JOB_STARTED = jobStartedHook;
      serviceOverrides = lib.mapAttrs (_: lib.mkForce) requiredUnitSettings // {
        # nixpkgs restarts an ephemeral runner only after a clean exit, and a
        # killed job must not take the runner out of the pool (Restart). No
        # grace period on stop, including the stop the watcher's own exit causes:
        # that could outlast the kill bound (KillSignal).
        RestartSec = lib.mkDefault "10s";
        # A daemon's builds would run outside this cgroup, beyond the kill. The tick needs no Nix.
        InaccessiblePaths = [ "-/nix/var/nix/daemon-socket" ];
      };
    });

    systemd.services = lib.mkMerge (
      map (name: {
        ${runnerUnit name} = {
          bindsTo = [ "${watcherUnit name}.service" ];
          after = [ "${watcherUnit name}.service" ];
          startLimitIntervalSec = 0;
        };
        ${watcherUnit name} = {
          description = "Kill bound for qlander runner ${name}";
          wantedBy = [ "multi-user.target" ];
          # systemd doesn't restart a unit stopped by the BindsTo above, so a
          # crashed watcher would leave the pool empty. To stop a runner, stop
          # its watcher.
          upholds = [ "${runnerUnit name}.service" ];
          path = [
            config.systemd.package
            pkgs.coreutils
          ];
          serviceConfig = {
            ExecStart = watcherScript name;
            Restart = "always";
            RestartSec = "1s";
            Nice = -10;
            OOMScoreAdjust = -1000;
            NoNewPrivileges = true;
            PrivateTmp = true;
            ProtectHome = true;
            ProtectSystem = "strict";
          };
          startLimitIntervalSec = 0;
        };
      }) names
    );
  };
}
