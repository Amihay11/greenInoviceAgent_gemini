Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File ""c:\Users\User\Documents\morningMCP\agent\agent-tray.ps1""", 0, False
