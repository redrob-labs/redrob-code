# Redrob Code installer for Windows (Windows PowerShell 5.1 and PowerShell 7).
#
#   irm https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install.ps1))) -Version 0.18.16
#
# The Windows counterpart of `install`: it picks the build for this CPU from the GitHub release,
# checks it against the release's SHA256SUMS.txt, and puts redrob.exe (and a redrob-code.exe copy)
# in %USERPROFILE%\.redrob\bin. That is where Redrob Desktop and the engine client look for the
# engine, and where `redrob upgrade` recognises an install it can replace. The folder goes on your
# own PATH. Nothing here needs administrator rights.
#
# There is deliberately no param() block: `irm ... | iex` cannot pass one. Options come from the
# arguments of the scriptblock form above, or from environment variables:
#
#   -Version <x.y.z>     REDROB_VERSION, REDROB_CODE_VERSION     Which release. Default: latest
#   -InstallDir <path>   REDROB_INSTALL_DIR, REDROB_CODE_INSTALL_DIR
#                                                                Default: %USERPROFILE%\.redrob\bin
#   -Binary <path>       REDROB_CODE_BIN                         Install a redrob.exe you already have
#   -NoModifyPath        REDROB_NO_MODIFY_PATH=1, REDROB_CODE_NO_PATH=1
#                                                                Leave your PATH alone
#   -Connect <rc_code>   REDROB_CONNECT                          Connect this PC to Redrob Chat after
#                                                                installing (the code from its connect card)
#                        REDROB_CODE_DOWNLOAD_BASE               Where the releases are (for tests)
#
# Everything runs inside one scriptblock so `iex` leaves no variables behind in your session, and a
# failure throws instead of calling `exit`, which would close the window `iex` was typed into.

& {
  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version 2.0
  # Invoke-WebRequest's progress bar makes a 150 MB download in Windows PowerShell 5.1 many times slower.
  $ProgressPreference = 'SilentlyContinue'

  $Repo = 'redrob-labs/redrob-code'
  $ReadmeUrl = "https://github.com/$Repo#readme"

  function Get-Setting([string[]] $Names) {
    foreach ($name in $Names) {
      $value = [Environment]::GetEnvironmentVariable($name)
      if ($value) { return $value.Trim() }
    }
    return ''
  }

  $requestedVersion = Get-Setting @('REDROB_VERSION', 'REDROB_CODE_VERSION')
  $installDir = Get-Setting @('REDROB_INSTALL_DIR', 'REDROB_CODE_INSTALL_DIR')
  $binaryPath = Get-Setting @('REDROB_CODE_BIN')
  $connectCode = Get-Setting @('REDROB_CONNECT')
  $noModifyPath = (Get-Setting @('REDROB_NO_MODIFY_PATH', 'REDROB_CODE_NO_PATH')) -eq '1'
  $downloadBase = Get-Setting @('REDROB_CODE_DOWNLOAD_BASE')
  if (-not $downloadBase) { $downloadBase = "https://github.com/$Repo/releases" }
  $downloadBase = $downloadBase.TrimEnd('/')

  $rest = @($args)
  for ($i = 0; $i -lt $rest.Count; $i++) {
    $arg = [string] $rest[$i]
    $next = if ($i + 1 -lt $rest.Count) { [string] $rest[$i + 1] } else { '' }
    switch -Regex ($arg) {
      '^-{1,2}(h|help|\?)$' {
        Write-Host 'Redrob Code installer for Windows'
        Write-Host ''
        Write-Host '  irm https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install.ps1 | iex'
        Write-Host '  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/redrob-labs/redrob-code/main/install.ps1))) -Version 0.18.16'
        Write-Host ''
        Write-Host 'Options: -Version <x.y.z>  -InstallDir <path>  -Binary <path>  -NoModifyPath  -Connect <rc_code>'
        Write-Host 'Env:     REDROB_VERSION  REDROB_INSTALL_DIR  REDROB_CODE_BIN  REDROB_NO_MODIFY_PATH=1  REDROB_CONNECT'
        return
      }
      '^-{1,2}(v|version)$' {
        if (-not $next) { throw '-Version needs a version, for example -Version 0.18.16' }
        $requestedVersion = $next; $i++; continue
      }
      '^-{1,2}(installdir|install-dir)$' {
        if (-not $next) { throw '-InstallDir needs a folder' }
        $installDir = $next; $i++; continue
      }
      '^-{1,2}(b|binary)$' {
        if (-not $next) { throw '-Binary needs the path of a redrob.exe' }
        $binaryPath = $next; $i++; continue
      }
      '^-{1,2}(nomodifypath|no-modify-path)$' { $noModifyPath = $true; continue }
      '^-{1,2}connect$' {
        if (-not $next) { throw "-Connect needs the rc_... code from Redrob Chat's connect card" }
        $connectCode = $next; $i++; continue
      }
      default { Write-Warning "Unknown option '$arg'" }
    }
  }

  if ($connectCode -and $connectCode -notmatch '^rc_[A-Za-z0-9_-]{8,128}$') {
    throw "-Connect needs the rc_... code from Redrob Chat's connect card"
  }
  if (-not $installDir) { $installDir = Join-Path $env:USERPROFILE '.redrob\bin' }
  $installDir = [IO.Path]::GetFullPath($installDir)
  $target = Join-Path $installDir 'redrob.exe'

  # Windows PowerShell 5.1 still defaults to TLS 1.0, which github.com refuses.
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {}

  function Get-Text([string] $Url) {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
    return [string] $content
  }

  function Get-Arch {
    $arch = ''
    try { $arch = [string] [Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch {}
    if (-not $arch) {
      # A 32-bit PowerShell on 64-bit Windows reports the real CPU in PROCESSOR_ARCHITEW6432.
      $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
    switch -Regex ($arch) {
      '^(X64|AMD64)$' { return 'x64' }
      '^(Arm64|ARM64)$' { return 'arm64' }
      default { throw "Redrob Code has no Windows build for $arch. x64 and arm64 are the builds there are." }
    }
  }

  function Test-Avx2 {
    # PF_AVX2_INSTRUCTIONS_AVAILABLE (40). Without AVX2 the regular x64 build crashes on start,
    # so such a CPU gets the baseline build, as `install` does.
    try {
      if (-not ('RedrobInstall.Kernel32' -as [type])) {
        Add-Type -Namespace RedrobInstall -Name Kernel32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);'
      }
      return [RedrobInstall.Kernel32]::IsProcessorFeaturePresent(40)
    } catch {
      return $false
    }
  }

  function Install-Binary([string] $From) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    foreach ($name in @('redrob.exe', 'redrob-code.exe')) {
      $to = Join-Path $installDir $name
      $old = "$to.old"
      # A running .exe cannot be overwritten or deleted, but it can be renamed, so the one in use
      # (`redrob upgrade`, a daemon Redrob Desktop started) moves aside and the .old goes next time.
      Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $to) { Move-Item -LiteralPath $to -Destination $old -Force }
      Copy-Item -LiteralPath $From -Destination $to -Force
      Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    }
  }

  function Add-UserPath([string] $Dir) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      # Read it unexpanded and write it back as REG_EXPAND_SZ, so entries like %USERPROFILE%\bin survive.
      $current = [string] $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $want = $Dir.TrimEnd('\')
      $present = $current -split ';' | Where-Object { $_ -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $want }
      if ($present) { return $false }
      # First, as `install` does, so this copy wins over an older one (an .msi install appends).
      $value = if ($current) { $Dir + ';' + $current.TrimStart(';') } else { $Dir }
      $key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
      $key.Close()
    }
    # Tell Explorer the environment changed, so terminals opened from it see the new PATH.
    try {
      if (-not ('RedrobInstall.User32' -as [type])) {
        Add-Type -Namespace RedrobInstall -Name User32 -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
      }
      $result = [UIntPtr]::Zero
      [RedrobInstall.User32]::SendMessageTimeout([IntPtr] 0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref] $result) | Out-Null
    } catch {}
    return $true
  }

  if ($binaryPath) {
    if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) { throw "Binary not found at $binaryPath" }
    Write-Host "Installing redrob from $binaryPath"
    Install-Binary ([IO.Path]::GetFullPath($binaryPath))
  } else {
    $arch = Get-Arch
    $asset = "redrob-windows-$arch"
    if ($arch -eq 'x64' -and -not (Test-Avx2)) { $asset = "$asset-baseline" }
    $asset = "$asset.zip"

    if ($requestedVersion) {
      $version = $requestedVersion -replace '^v', ''
    } else {
      # The marker the release workflow publishes beside the newest release: a redirect, not the
      # GitHub API, so it has no anonymous rate limit. `redrob upgrade` reads the same file.
      try {
        $version = (Get-Text "$downloadBase/latest/download/VERSION").Trim() -replace '^v', ''
      } catch {
        throw "Could not read $downloadBase/latest/download/VERSION, so the newest version is unknown. Releases: https://github.com/$Repo/releases"
      }
    }
    if ($version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') { throw "'$version' is not a version" }

    $installed = ''
    if (Test-Path -LiteralPath $target) {
      try { $installed = ((& $target --version) | Out-String).Trim() } catch {}
      if ($installed -eq $version -and -not $connectCode) {
        Write-Host "Version $version already installed in $installDir"
        return
      }
      if ($installed) { Write-Host "Installed version: $installed" }
    }

    $work = Join-Path ([IO.Path]::GetTempPath()) ("redrob-install-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
      if (-not ($installed -eq $version)) {
        Write-Host ''
        Write-Host "Installing redrob version: $version ($asset)"
        $releaseUrl = "$downloadBase/download/v$version"
        $zip = Join-Path $work $asset
        try {
          Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $zip -UseBasicParsing
        } catch {
          throw "Could not download $releaseUrl/$asset. Is v$version a release? https://github.com/$Repo/releases"
        }

        # One checksum file per release covers every asset; the line for this asset is picked by
        # name. Releases up to v0.6.4 published it as SHA256SUMS.
        $sums = $null
        foreach ($name in @('SHA256SUMS.txt', 'SHA256SUMS')) {
          try { $sums = Get-Text "$releaseUrl/$name"; break } catch {}
        }
        if (-not $sums) { throw "v$version publishes no SHA256SUMS.txt, so $asset cannot be verified. Nothing was installed." }
        $expected = ''
        foreach ($line in ($sums -split "`n")) {
          $parts = $line.Trim() -split '\s+'
          if ($parts.Count -ge 2 -and ($parts[1] -eq $asset -or $parts[1] -eq "*$asset")) { $expected = $parts[0].ToLowerInvariant(); break }
        }
        if (-not $expected) { throw "SHA256SUMS.txt in v$version has no line for $asset. Nothing was installed." }
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "Checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed." }

        $unpacked = Join-Path $work 'x'
        Expand-Archive -LiteralPath $zip -DestinationPath $unpacked -Force
        $exe = Get-ChildItem -LiteralPath $unpacked -Recurse -Filter 'redrob.exe' | Select-Object -First 1
        if (-not $exe) { throw "$asset holds no redrob.exe" }
        Install-Binary $exe.FullName
      }
    } finally {
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  $onPath = @($env:Path -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ieq $installDir.TrimEnd('\') }).Count -gt 0
  if (-not $onPath) {
    if ($noModifyPath) {
      Write-Host ''
      Write-Host "$installDir is not on your PATH, and your PATH was left alone. Add it yourself to run redrob by name."
    } else {
      if (Add-UserPath $installDir) { Write-Host "Added $installDir to your user PATH" }
      # This session too, so `redrob` works right away after `irm ... | iex`.
      $env:Path = "$installDir;$env:Path"
    }
  }

  if ($env:GITHUB_ACTIONS -eq 'true' -and $env:GITHUB_PATH) {
    Add-Content -LiteralPath $env:GITHUB_PATH -Value $installDir
    Write-Host "Added $installDir to `$GITHUB_PATH"
  }

  Write-Host ''
  Write-Host 'Redrob Code'
  Write-Host ''
  Write-Host 'To start, open your project and run redrob, then type /connect to sign in:'
  # The same line in Korean, kept as UTF-8 bytes so this file stays ASCII: Windows PowerShell 5.1
  # reads a script without a BOM in the ANSI code page, and `irm` text is not always UTF-8 either.
  Write-Host ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('7Iuc7J6R7ZWY66Ck66m0IO2UhOuhnOygne2KuCDtj7TrjZTsl5DshJwgcmVkcm9i7J2EIOyLpO2Wie2VnCDrkqQgL2Nvbm5lY3Trpbwg7J6F66Cl7ZW0IOuhnOq3uOyduO2VmOyEuOyalDo=')))
  Write-Host ''
  Write-Host '  cd <project>'
  Write-Host '  redrob'
  Write-Host '  /connect'
  Write-Host ''
  Write-Host "More: $ReadmeUrl"
  Write-Host ''

  if ($connectCode) {
    Write-Host 'Connecting this PC to Redrob Chat'
    & $target desk connect $connectCode
    if ($LASTEXITCODE -ne 0) { throw "redrob desk connect failed with code $LASTEXITCODE" }
  }
} @args
