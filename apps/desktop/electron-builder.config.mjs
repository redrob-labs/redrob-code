// electron-builder configuration for Redrob Code Desktop.
//
// Artifact names all start `redrob-code-desktop-`. The CLI's assets in the same release are
// `redrob-<os>-<arch>.{zip,tar.gz}` and `redrob-code-x64-setup.exe`, and `install` looks for exactly
// `redrob-$target.$ext`, so no desktop file can ever be picked up by the CLI installer or by
// `redrob upgrade`. test/artifacts.test.ts holds that line.
//
// Signing on Windows follows release.yml's rule: Azure Trusted Signing when all six AZURE_* values are
// present, else the organisation PFX through CSC_LINK / CSC_KEY_PASSWORD, else unsigned (and the
// workflow says so). macOS and Linux targets are declared now so their milestones change the
// workflow, not this file.

const azure =
  process.env.AZURE_ARTIFACT_SIGNING_ENDPOINT &&
  process.env.AZURE_ARTIFACT_SIGNING_ACCOUNT &&
  process.env.AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE
    ? {
        endpoint: process.env.AZURE_ARTIFACT_SIGNING_ENDPOINT,
        codeSigningAccountName: process.env.AZURE_ARTIFACT_SIGNING_ACCOUNT,
        certificateProfileName: process.env.AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE,
        publisherName: "Redrob",
      }
    : undefined

/** @type {import("electron-builder").Configuration} */
export default {
  appId: "ai.redrob.code",
  productName: "Redrob Code",
  executableName: "redrob-code-desktop",
  artifactName: "redrob-code-desktop-${version}-${os}-${arch}.${ext}",
  copyright: "Copyright © Redrob",
  directories: { output: "dist", buildResources: "build" },
  // Everything the app runs is bundled into out/ (script/build.ts), so there is nothing to collect.
  // In a bun workspace electron-builder finds no node_modules beside the app and walks up to the
  // workspace root, which would pack the root's dependencies (the AWS SDK, effect, …) into app.asar
  // and grow it from 1.7 MB to 69 MB. The exclusion stops that; the packaged smoke test proves the
  // bundle needs nothing more.
  files: ["out/**/*", "package.json", "!node_modules/**/*"],
  npmRebuild: false,
  nodeGypRebuild: false,
  asar: true,
  extraResources: [
    { from: "../studio/dist", to: "studio" },
    { from: "resources/engine", to: "engine" },
  ],
  protocols: [{ name: "Redrob Code", schemes: ["redrob-code"] }],
  publish: [{ provider: "github", owner: "redrob-labs", repo: "redrob-code", releaseType: "release" }],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    signtoolOptions: { signingHashAlgorithms: ["sha256"] },
    ...(azure ? { azureSignOptions: azure } : {}),
  },
  nsis: {
    // Per-user, no UAC prompt, and the person sees where it goes before anything is written.
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    // Uninstalling the app removes the app. The CLI, the engine's data and the person's sessions stay.
    deleteAppDataOnUninstall: false,
    shortcutName: "Redrob Code",
    uninstallDisplayName: "Redrob Code Desktop",
  },
  linux: {
    target: ["AppImage", "deb", "tar.gz"],
    category: "Development",
    executableName: "redrob-code-desktop",
  },
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    notarize: false,
  },
}
