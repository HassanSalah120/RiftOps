; RiftOps Inno Setup Script
; Builds a lightweight, user-mode Windows Setup installer for RiftOps League Companion.

#ifndef AppVersion
  #define AppVersion "2.8.3"
#endif

#ifndef SourceExe
  #define SourceExe "..\dist\RiftOps-" + AppVersion + "-win-x64.exe"
#endif

#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

[Setup]
AppId={{E68BC347-1B9E-4C2E-8E2E-73D2952A9D1C}
AppName=RiftOps
AppVersion={#AppVersion}
AppVerName=RiftOps {#AppVersion}
AppPublisher=Hassan Salah
AppPublisherURL=https://hassansalah120.github.io/RiftOps/
AppSupportURL=https://github.com/HassanSalah120/RiftOps
AppUpdatesURL=https://github.com/HassanSalah120/RiftOps/releases
DefaultDirName={localappdata}\Programs\RiftOps
DefaultGroupName=RiftOps
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=RiftOps-Setup-{#AppVersion}-x64
SetupIconFile=..\cmd\riftops-ui\app.ico
UninstallDisplayIcon={app}\RiftOps.exe
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "runonstartup"; Description: "Start RiftOps automatically when Windows starts"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "RiftOps.exe"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\RiftOps"; Filename: "{app}\RiftOps.exe"
Name: "{autodesktop}\RiftOps"; Filename: "{app}\RiftOps.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "RiftOps"; ValueData: """{app}\RiftOps.exe"""; Flags: uninsdeletevalue; Tasks: runonstartup

[Run]
Filename: "{app}\RiftOps.exe"; Description: "{cm:LaunchProgram,RiftOps}"; Flags: nowait postinstall skipifsilent
