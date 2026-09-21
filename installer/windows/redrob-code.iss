; Redrob Code Windows installer.
;
; Produces `redrob-code-x64-setup.exe`: a click-to-run installer, so Windows is not the one
; platform where the only way in is to paste a PowerShell one-liner. That asymmetry is what this
; exists to remove -- kiro.dev hands a Windows user a signed .exe, and until now this project
; handed them a `curl` command and an archive whose name did not even exist in the release.
;
; Four deliberate choices, each of which is a reversal of what an installer usually does:
;
;   1. NO ELEVATION. `PrivilegesRequired=lowest` and everything lands under %LOCALAPPDATA%. A CLI
;      that a developer runs as themselves does not need Administrator, and asking for it means a
;      UAC prompt on every update plus a binary a non-admin cannot repair. The cost is that the
;      install is per-user, which is the correct scope anyway.
;
;   2. USER PATH ONLY. The machine PATH is shared state owned by the administrator; a per-user
;      install has no business in it. `ChangesEnvironment=yes` makes the installer broadcast the
;      environment change so an already-open Explorer picks it up, though an already-open terminal
;      still has to be restarted -- that is a Windows fact, not something the installer can fix, so
;      the finished page says so rather than leaving the user to discover it.
;
;   3. THE SAME TWO NAMES THE OTHER PLATFORMS INSTALL. install.sh writes both `redrob` and
;      `redrob-code`; this writes `redrob.exe` and `redrob-code.exe`. A script that works on macOS
;      must not fail on Windows because one of the two names is missing.
;
;   4. INSTALL DIRECTORY IS FIXED, NOT ASKED. `DisableDirPage=yes`. The CLI recognises its own
;      install by location -- see `isCurlInstall` -- so a user who relocates it gets a binary that
;      cannot upgrade itself in place. Rather than offer a choice that quietly breaks upgrades, the
;      directory is fixed and REDROB_CODE_INSTALL_DIR remains the documented escape hatch for the
;      people who genuinely want one.
;
; Built and signed by the `sign-windows` job in .github/workflows/release.yml, which signs the
; binaries FIRST and the installer SECOND, so neither the payload nor the wrapper is unsigned.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceBin
  #define SourceBin "..\dist\redrob-windows-x64\bin"
#endif

[Setup]
AppId={{8F4C6A21-9E3B-4D77-A5C8-2B1E7F0D9A64}
AppName=Redrob Code
AppVersion={#AppVersion}
AppPublisher=Redrob
AppPublisherURL=https://redrob.ai
AppSupportURL=https://github.com/redrob-labs/redrob-code/issues
VersionInfoVersion={#AppVersion}

; Per-user, under LOCALAPPDATA. `{autopf}` would need elevation; `{localappdata}` does not.
DefaultDirName={localappdata}\Redrob\bin
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; A CLI has no Start-menu group worth creating and no directory worth choosing.
DisableDirPage=yes
DisableProgramGroupPage=yes
Uninstallable=yes
UninstallDisplayName=Redrob Code
UninstallFilesDir={localappdata}\Redrob\uninstall

OutputDir=.
OutputBaseFilename=redrob-code-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

; The payload is x64. Declaring it keeps the installer from running on an architecture whose
; binary this is not, which would otherwise fail at first run rather than at install.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Set so the installer itself announces the PATH change to the shell.
ChangesEnvironment=yes

[Files]
; `redrob.exe` is the build output. `redrob-code.exe` is the same program under the second name the
; other platforms also install; Inno has no hard-link concept, so this is a copy rather than
; install.sh's hard link. It costs disk, and the alternative -- shipping only one name -- costs a
; script that works everywhere except here.
Source: "{#SourceBin}\redrob.exe"; DestDir: "{app}"; DestName: "redrob.exe"; Flags: ignoreversion
Source: "{#SourceBin}\redrob.exe"; DestDir: "{app}"; DestName: "redrob-code.exe"; Flags: ignoreversion

[Tasks]
Name: "addtopath"; Description: "Add Redrob Code to my PATH"; GroupDescription: "Shell integration:"

[Registry]
; HKCU only, and `expandsz` because a user PATH normally holds unexpanded variables; writing it as
; a plain string would flatten anything already there. `Check:` keeps the entry from being appended
; twice when the installer is run again over an existing install.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Flags: preservestringtype; \
  Tasks: addtopath; Check: NeedsPathEntry(ExpandConstant('{app}'))

[Code]
{ True when the install directory is not already on the user's PATH. Compared case-insensitively
  and delimiter-anchored, so `C:\...\Redrob\bin` is not treated as present because
  `C:\...\Redrob\bin2` happens to be. }
function NeedsPathEntry(Directory: string): Boolean;
var
  Existing: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Existing) then
    Existing := '';
  Result := Pos(';' + Lowercase(Directory) + ';', ';' + Lowercase(Existing) + ';') = 0;
end;

{ Inno does NOT undo a registry append on uninstall, so without this the uninstaller leaves a PATH
  entry pointing at a directory it just deleted. Every later shell then carries a dead segment, and
  they accumulate one per install/uninstall cycle.

  Rebuilt by splitting on ';' and dropping only exact matches, rather than by string replacement:
  replacing a substring would corrupt a sibling path that merely starts with the same characters. }
procedure RemoveFromUserPath(Directory: string);
var
  Existing, Rebuilt, Segment: string;
  Position: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Existing) then
    exit;

  Rebuilt := '';
  Existing := Existing + ';';
  repeat
    Position := Pos(';', Existing);
    Segment := Trim(Copy(Existing, 1, Position - 1));
    Delete(Existing, 1, Position);
    if (Segment <> '') and (Lowercase(Segment) <> Lowercase(Directory)) then
    begin
      if Rebuilt <> '' then Rebuilt := Rebuilt + ';';
      Rebuilt := Rebuilt + Segment;
    end;
  until Existing = '';

  if Rebuilt = '' then
    RegDeleteValue(HKEY_CURRENT_USER, 'Environment', 'Path')
  else
    RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Rebuilt);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { usUninstall, not usPostUninstall: the value is removed while the app path is still known good. }
  if CurUninstallStep = usUninstall then
    RemoveFromUserPath(ExpandConstant('{app}'));
end;

[Messages]
FinishedLabel=Redrob Code is installed.%n%nOpen a NEW terminal and run `redrob --version`. An already-open terminal still holds the old PATH and will not find it until it is restarted.

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
