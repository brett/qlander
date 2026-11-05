{
  description = "NixOS runner module for qlander, with its VM tests";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    {
      nixosModules.runner = ./nixos/runner.nix;

      # x86_64-linux only: the Bun the tick pins (template/.github/bun-release.txt) is that build.
      checks.x86_64-linux = import ./nixos/checks.nix {
        inherit nixpkgs;
        module = self.nixosModules.runner;
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
      };
    };
}
