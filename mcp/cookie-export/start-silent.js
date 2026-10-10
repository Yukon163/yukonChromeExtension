(function () {
    // Run under the GUI Windows Script Host so no console is created for this launcher.
    var args = WScript.Arguments;
    if (args.length !== 2) { WScript.Quit(2); return; }
    function quote(value) {
        if (/["\r\n]/.test(value)) throw new Error('Invalid startup path');
        return '"' + value + '"';
    }
    var files = new ActiveXObject('Scripting.FileSystemObject');
    var script = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), 'check-service.ps1');
    var command = quote(args.Item(0)) + ' -NoProfile -NonInteractive -WindowStyle Hidden -File ' + quote(script) + ' -BridgeHome ' + quote(args.Item(1));
    // Set the initial window style before PowerShell starts, and return its exit code.
    WScript.Quit(new ActiveXObject('WScript.Shell').Run(command, 0, true));
})();
