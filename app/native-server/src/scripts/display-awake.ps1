#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    if (-not $IsWindows) {
        throw 'The display-awake helper requires Windows.'
    }

    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AIEasyBrowserDisplayAwake
{
    private const uint Continuous = 0x80000000;
    private const uint DisplayRequired = 0x00000002;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint flags);

    private static void SetState(uint flags)
    {
        if (SetThreadExecutionState(flags) == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetThreadExecutionState failed");
        }
    }

    private static void Reply(string json)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    public static void Run()
    {
        // All P/Invokes and the blocking stdin loop stay on this one OS thread.
        try
        {
            SetState(Continuous | DisplayRequired);
            Reply("{\"type\":\"ready\",\"protocol\":1}");
            string command;
            while ((command = Console.In.ReadLine()) != null)
            {
                if (command == "stop") return;
                if (command != "wake") throw new InvalidOperationException("Unknown display-awake command");
                // Pulse the display idle timer even when a continuous request already exists.
                SetState(DisplayRequired);
                Reply("{\"type\":\"awake\"}");
            }
        }
        finally
        {
            SetState(Continuous);
        }
    }
}
'@

    [AIEasyBrowserDisplayAwake]::Run()
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Out.WriteLine('{"type":"error","message":"display-awake helper failed"}')
    [Console]::Out.Flush()
    exit 1
}
