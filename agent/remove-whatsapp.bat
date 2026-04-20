@echo off
echo ==============================================
echo        WhatsApp Account Removal Tool
echo ==============================================
echo.
echo IMPORTANT: Please ensure you have stopped the Morning AI Agent
echo from the System Tray (Right-Click -^> Stop Agent ^& Exit) before continuing!
echo.
pause

echo.
echo Deleting WhatsApp session data...
rmdir /S /Q "%~dp0whatsapp-auth"

echo.
echo Done! The WhatsApp session has been removed.
echo The next time you start the agent, it will generate a new QR code.
echo.
pause
