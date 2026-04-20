Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$workspaceDir = "c:\Users\User\Documents\morningMCP"
$agentDir = "$workspaceDir\agent"
$nodeExe = "$workspaceDir\node\node-v20.12.2-win-x64\node.exe"
$scriptPath = "$agentDir\index.js"
$logFile = "$agentDir\agent.log"

# Kill any existing node agent process first to prevent duplicates
$existingProcesses = Get-WmiObject Win32_Process -Filter "CommandLine LIKE '%agent\\index.js%'"
foreach ($ep in $existingProcesses) {
    Stop-Process -Id $ep.ProcessId -Force -ErrorAction SilentlyContinue
}

# Start the Node process hidden
$process = Start-Process -FilePath $nodeExe -ArgumentList $scriptPath -WorkingDirectory $agentDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$agentDir\agent-error.log"

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Text = "Morning AI Agent"
# Use the node.exe icon
$icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($nodeExe)
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenu
$itemLogs = New-Object System.Windows.Forms.MenuItem
$itemLogs.Text = "View Logs"
$itemLogs.add_Click({
    Start-Process notepad.exe -ArgumentList $logFile
})

$itemStop = New-Object System.Windows.Forms.MenuItem
$itemStop.Text = "Stop Agent & Exit"
$itemStop.add_Click({
    if ($process -ne $null -and !$process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    $icon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$menu.MenuItems.Add($itemLogs) | Out-Null
$menu.MenuItems.Add($itemStop) | Out-Null
$icon.ContextMenu = $menu

$icon.ShowBalloonTip(3000, "Morning AI Agent", "The agent is running in the background.", [System.Windows.Forms.ToolTipIcon]::Info)

# Block and run the tray app
[System.Windows.Forms.Application]::Run()
