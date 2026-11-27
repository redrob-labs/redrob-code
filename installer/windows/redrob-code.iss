; Redrob Code Windows installer.
;
; Produces `redrob-code-<version>-windows-x64-setup.exe`: a click-to-run installer, so Windows is not the one
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
; Redrob Drive is the same binary and install dir as Redrob Code, repackaged for non-developers
; (ISCC `/DDRIVE`): the window is branded Redrob Drive and the install runs `redrob drive setup`
; by default. Same AppId on purpose -- it is one installed program under two front doors.
#ifdef DRIVE
; 레드롭 드라이브 on a Korean Windows, Redrob Drive elsewhere ([CustomMessages] below).
AppName={cm:DriveName}
#else
AppName=Redrob Code
#endif
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
#ifdef DRIVE
UninstallDisplayName=Redrob Drive
#else
UninstallDisplayName=Redrob Code
#endif
UninstallFilesDir={localappdata}\Redrob\uninstall

OutputDir=.
; `<repo>-<version>-<os>-<arch>-setup`: the asset-name convention Redrob Launcher parses
; (`redrob-code-0.6.8-windows-x64-setup.exe`), so a Windows user and the launcher see the same
; version in the file name as in the release tag.
#ifdef DRIVE
OutputBaseFilename=redrob-drive-{#AppVersion}-windows-x64-setup
#else
OutputBaseFilename=redrob-code-{#AppVersion}-windows-x64-setup
#endif
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

; Redrob's own mark on the installer file, its window and the two wizard images (one per DPI step),
; in place of Inno's default box-and-disc.
SetupIconFile=redrob.ico
UninstallDisplayIcon={app}\redrob.exe
WizardImageFile=wizard-164.bmp,wizard-205.bmp,wizard-246.bmp,wizard-328.bmp
WizardSmallImageFile=small-55.bmp,small-69.bmp,small-83.bmp,small-110.bmp
; Korean on a Korean Windows, English elsewhere, without asking.
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage

#ifdef DRIVE
; Redrob Drive is one click: no welcome, no tasks, no "ready" page. Double-click, it installs, and
; the browser opens to connect it.
DisableWelcomePage=yes
DisableReadyPage=yes
#endif

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
; Redrob Drive's tray icon (crates/tray), started by `redrob drive setup`. Optional in the payload so
; a local build of the installer without it still compiles.
Source: "{#SourceBin}\redrob-tray.exe"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

#ifndef DRIVE
[Tasks]
Name: "addtopath"; Description: "Add Redrob Code to my PATH"; GroupDescription: "Shell integration:"
; In a plain Redrob Code install, Redrob Drive setup is an off-by-default opt-in task; a person can
; tick it here. The dedicated Redrob Drive installer (/DDRIVE) runs it unconditionally instead.
Name: "drivesetup"; Description: "Set up Redrob Drive (let Redrob Chat work with this computer's files)"; GroupDescription: "Redrob Drive:"; Flags: unchecked
#endif

[Registry]
; HKCU only, and `expandsz` because a user PATH normally holds unexpanded variables; writing it as
; a plain string would flatten anything already there. `Check:` keeps the entry from being appended
; twice when the installer is run again over an existing install.
; Redrob Drive asks nothing: the engine goes on PATH as it always does, so `redrob` works in a
; terminal for anyone who later wants it.
#ifdef DRIVE
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Flags: preservestringtype; \
  Check: NeedsPathEntry(ExpandConstant('{app}'))
#else
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Flags: preservestringtype; \
  Tasks: addtopath; Check: NeedsPathEntry(ExpandConstant('{app}'))
#endif

[Run]
; Redrob Drive setup: open the home folder to Redrob Chat, turn the desk on, register the engine to
; start at login, and sign in. `drive setup` signs in to production; a dev test points the daemon at
; dev by running `redrob drive setup` from a shell with REDROB_CHAT_API_URL set.
#ifdef DRIVE
; Dedicated Redrob Drive installer: setup runs at the end of the install, with no checkbox, while
; the installer still owns the foreground, so the browser it opens comes to the front. Hidden: it
; is a console program. Still skipped on a silent install.
Filename: "{app}\redrob.exe"; Parameters: "drive setup"; StatusMsg: "{cm:DriveConnecting}"; \
  Flags: nowait runhidden skipifsilent
#else
; Plain Redrob Code installer: only when the opt-in task is ticked.
Filename: "{app}\redrob.exe"; Parameters: "drive setup"; Description: "Set up Redrob Drive"; \
  Flags: postinstall nowait skipifsilent; Tasks: drivesetup
#endif

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

{ A running shared daemon is `redrob.exe serve --register` from this directory, and Windows will not
  overwrite an exe that is running. Stop it through the installed CLI before [Files] replaces it;
  attached apps reconnect and start the new version. Any failure (no install yet, nothing running,
  an old binary without `service stop`) is ignored: the install proceeds either way. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Existing: string;
  ResultCode: Integer;
begin
  Result := '';
  { The tray icon first: it starts the engine again whenever none is running, so stopping the
    engine while it is still up lost the race and left redrob.exe locked ("DeleteFile failed;
    code 5"). It is started again after the install. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM redrob-tray.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Existing := ExpandConstant('{app}\redrob.exe');
  if FileExists(Existing) then
    Exec(Existing, 'service stop', ExpandConstant('{localappdata}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

const
  TrayRunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  TrayRunValue = 'Redrob Drive';

{ After an update, bring the tray icon back for a person who set Drive up: its login entry holds
  the exact command line `redrob drive setup` registered. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  Line: string;
  ResultCode: Integer;
begin
  if (CurStep = ssPostInstall) and RegQueryStringValue(HKEY_CURRENT_USER, TrayRunKey, TrayRunValue, Line) then
    Exec(ExpandConstant('{cmd}'), '/c start "" ' + Line, '', SW_HIDE, ewNoWait, ResultCode);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  { usUninstall, not usPostUninstall: the value is removed while the app path is still known good. }
  if CurUninstallStep = usUninstall then
  begin
    RemoveFromUserPath(ExpandConstant('{app}'));
    { Close the tray icon and drop its login entry, so nothing points at a deleted program. }
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM redrob-tray.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    RegDeleteValue(HKEY_CURRENT_USER, TrayRunKey, TrayRunValue);
  end;
end;

[Languages]
; English is Inno's default text. Korean is the same file with every line this installer shows
; written over below, so it needs no translation file the build image may not ship.
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "korean"; MessagesFile: "compiler:Default.isl"

[LangOptions]
korean.LanguageName=한국어
korean.LanguageID=$0412
korean.LanguageCodePage=0

[CustomMessages]
english.DriveName=Redrob Drive
korean.DriveName=레드롭 드라이브
english.DriveConnecting=Opening your browser to connect your computer...
korean.DriveConnecting=내 컴퓨터를 연결하도록 브라우저를 여는 중이에요...

[Messages]
#ifdef DRIVE
; Inno always shows one page before it installs: for Redrob Drive that is this one, the whole
; pitch and one Install button.
english.WizardReady=Install Redrob Drive
english.ReadyLabel1=Redrob Drive connects this computer to Redrob Chat, so chat can find, read and organize your files.
english.ReadyLabel2b=Click Install. Your browser opens next to connect it with your Redrob account.
korean.WizardReady=레드롭 드라이브 설치
korean.ReadyLabel1=레드롭 드라이브는 이 컴퓨터를 레드롭 챗과 연결해요. 챗에서 내 파일을 찾고, 읽고, 정리할 수 있어요.
korean.ReadyLabel2b=설치를 누르세요. 그다음 브라우저가 열리면 레드롭 계정으로 연결해요.
english.FinishedHeadingLabel=Redrob Drive is installed
english.FinishedLabel=Your browser opened to connect this computer to Redrob Chat. Allow it once with your Redrob account.%n%nAfter that, Redrob Drive stays on in the background. Look for the Redrob icon on the taskbar.
korean.FinishedHeadingLabel=레드롭 드라이브를 설치했어요
korean.FinishedLabel=브라우저가 열렸어요. 레드롭 계정으로 한 번 허용하면 이 컴퓨터가 레드롭 챗과 연결돼요.%n%n그다음엔 백그라운드에서 항상 켜져 있어요. 작업 표시줄의 레드롭 아이콘을 확인해 보세요.
#else
english.FinishedLabel=Redrob Code is installed.%n%nOpen a NEW terminal and run `redrob --version`. An already-open terminal still holds the old PATH and will not find it until it is restarted.
korean.FinishedLabel=레드롭 코드를 설치했어요.%n%n새 터미널을 열고 `redrob --version`을 실행해 보세요. 이미 열려 있던 터미널은 다시 열어야 찾을 수 있어요.
#endif
korean.SetupAppTitle=설치
korean.SetupWindowTitle=설치 - %1
korean.UninstallAppTitle=제거
korean.UninstallAppFullTitle=%1 제거
korean.ButtonBack=< 이전
korean.ButtonNext=다음 >
korean.ButtonInstall=설치
korean.ButtonOK=확인
korean.ButtonCancel=취소
korean.ButtonYes=예
korean.ButtonNo=아니요
korean.ButtonFinish=마침
korean.ExitSetupTitle=설치 그만두기
korean.ExitSetupMessage=아직 설치가 끝나지 않았어요. 지금 그만두면 설치되지 않아요.%n%n나중에 다시 실행하면 이어서 설치할 수 있어요.%n%n설치를 그만둘까요?
korean.WizardPreparing=설치 준비 중
korean.PreparingDesc=설치할 준비를 하고 있어요.
korean.WizardInstalling=설치 중
korean.InstallingLabel=설치하고 있어요. 잠시만 기다려 주세요.
korean.StatusClosingApplications=프로그램을 닫는 중...
korean.StatusCreateDirs=폴더를 만드는 중...
korean.StatusExtractFiles=파일을 복사하는 중...
korean.StatusCreateIcons=바로 가기를 만드는 중...
korean.StatusCreateIniEntries=설정을 쓰는 중...
korean.StatusCreateRegistryEntries=설정을 쓰는 중...
korean.StatusSavingUninstall=제거 정보를 저장하는 중...
korean.StatusRunProgram=설치를 마무리하는 중...
korean.StatusRollback=바뀐 것을 되돌리는 중...
korean.WizardSelectTasks=추가 작업 고르기
korean.SelectTasksDesc=어떤 작업을 더 할까요?
korean.SelectTasksLabel2=설치하면서 할 작업을 고르고 다음을 누르세요.
korean.ReadyLabel2a=설치를 누르면 시작해요. 바꿀 것이 있으면 이전을 누르세요.
korean.ReadyMemoTasks=추가 작업:
#ifndef DRIVE
korean.WizardReady=설치 준비 완료
korean.ReadyLabel1=이 컴퓨터에 설치할 준비가 됐어요.
korean.ReadyLabel2b=설치를 누르면 시작해요.
korean.FinishedHeadingLabel=레드롭 코드 설치를 마쳤어요
#endif
korean.ClickFinish=마침을 누르면 설치 창이 닫혀요.
korean.ErrorTitle=오류
korean.AbortRetryIgnoreSelectAction=무엇을 할지 고르세요
korean.AbortRetryIgnoreRetry=다시 시도(&T)
korean.AbortRetryIgnoreIgnore=이 파일 건너뛰기 (권하지 않아요)(&S)
korean.AbortRetryIgnoreCancel=설치 그만두기
korean.ErrorReplacingExistingFile=있던 파일을 바꾸는 중에 문제가 생겼어요:
korean.UninstallStatusLabel=컴퓨터에서 지우고 있어요. 잠시만 기다려 주세요.
korean.ConfirmUninstall=%1 프로그램과 구성 요소를 모두 지울까요?
korean.UninstalledAll=%1 프로그램을 컴퓨터에서 지웠어요.

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
