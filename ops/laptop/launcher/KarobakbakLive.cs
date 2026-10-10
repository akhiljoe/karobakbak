// karobakbak live - the double-click launcher for the laptop deployment.
//
// Build:  powershell -ExecutionPolicy Bypass -File ops\laptop\launcher\build.ps1 -Shortcut
// Run:    double-click ops\laptop\karobakbak-live.exe (or the desktop shortcut)
// Check:  karobakbak-live.exe --check   (pre-checks only, no window, exit 1 on failure)
//
// Compiled by the C# compiler that ships with the .NET Framework in Windows
// (csc v4, so C# 5: no string interpolation, no ?. operator). Nothing to
// install, and the exe is a few dozen kilobytes.
//
// WHAT IT DOES, IN ORDER
//
//   1. Pre-checks. Every one names the step of docs/operations/LAPTOP-HOSTING.md
//      that fixes it. A FAIL stops the start; a WARN is shown and does not.
//   2. Starts Docker Desktop if it is not running, and waits for the engine.
//   3. `docker compose ... up -d --build` with the three files the laptop uses.
//   4. Waits for `migrate` to exit 0 - a stack whose migration failed has every
//      other container looking healthy.
//   5. Gives `karobakbak_app` its password on the first start (step 8.4), read
//      from DATABASE_URL and sent over stdin so it never appears in a process
//      list or in this program's log.
//   6. Waits for every service to be running and none restarting.
//   7. Waits for cloudflared to register with Cloudflare.
//   8. Asks the PUBLIC origin for /ready. A healthy container behind a dead
//      tunnel is an outage, so only this counts as "live".
//
// Stopping is `docker compose down` - never `-v`. There is no button that
// deletes data.
//
// The window can be closed at any time; the site keeps running. It is Docker
// Desktop, not this program, that keeps it up.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace Karobakbak.Live
{
    enum Level { Pass, Info, Warn, Fail }

    sealed class CheckResult
    {
        public string Name;
        public Level Level;
        public string Detail;

        public CheckResult(string name, Level level, string detail)
        {
            Name = name;
            Level = level;
            Detail = detail;
        }
    }

    sealed class RunResult
    {
        public int ExitCode;
        public string Output;
        public bool TimedOut;
    }

    // -----------------------------------------------------------------------
    // Running processes
    // -----------------------------------------------------------------------
    static class Proc
    {
        public static string DockerExe()
        {
            string fromPath = FindOnPath("docker.exe");
            if (fromPath != null) return fromPath;
            string fixedPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                @"Docker\Docker\resources\bin\docker.exe");
            return File.Exists(fixedPath) ? fixedPath : null;
        }

        public static string FindOnPath(string exe)
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(';'))
            {
                if (dir.Trim().Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(dir.Trim(), exe);
                    if (File.Exists(candidate)) return candidate;
                }
                catch (ArgumentException) { }
            }
            return null;
        }

        // Runs a program, streams each output line to onLine (may be null),
        // and returns everything it printed. stdin, when given, is written and
        // closed - used for SQL that carries a password.
        public static RunResult Run(string exe, string args, string workDir, int timeoutMs,
                                    Action<string> onLine, string stdin)
        {
            var result = new RunResult();
            var buffer = new StringBuilder();
            var psi = new ProcessStartInfo(exe, args);
            psi.WorkingDirectory = workDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.RedirectStandardInput = stdin != null;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            using (var p = new Process())
            {
                p.StartInfo = psi;
                DataReceivedEventHandler handler = delegate (object s, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    lock (buffer) buffer.AppendLine(e.Data);
                    if (onLine != null) onLine(e.Data);
                };
                p.OutputDataReceived += handler;
                p.ErrorDataReceived += handler;
                try
                {
                    p.Start();
                }
                catch (Exception ex)
                {
                    result.ExitCode = -1;
                    result.Output = "could not start " + exe + ": " + ex.Message;
                    return result;
                }
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                if (stdin != null)
                {
                    p.StandardInput.Write(stdin);
                    p.StandardInput.Close();
                }
                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch { }
                    result.TimedOut = true;
                    result.ExitCode = -1;
                }
                else
                {
                    p.WaitForExit(); // flushes the async readers
                    result.ExitCode = p.ExitCode;
                }
            }
            lock (buffer) result.Output = buffer.ToString();
            return result;
        }
    }

    // -----------------------------------------------------------------------
    // The deployment: where it is, what it is configured with, how to drive it
    // -----------------------------------------------------------------------
    sealed class Deployment
    {
        public const string Project = "karobakbak-live";
        public const string EnvFileName = ".env.laptop";
        public static readonly string[] ComposeFiles =
            { "docker-compose.yml", "docker-compose.prod.yml", "docker-compose.laptop.yml" };

        public readonly string Root;
        public Dictionary<string, string> Env = new Dictionary<string, string>();
        public string EnvRaw = "";
        public readonly string Docker;

        public Deployment(string root)
        {
            Root = root;
            Docker = Proc.DockerExe();
        }

        public string EnvPath { get { return Path.Combine(Root, EnvFileName); } }

        public string Compose(string rest)
        {
            var sb = new StringBuilder("compose --progress plain --env-file " + EnvFileName);
            foreach (string f in ComposeFiles) sb.Append(" -f " + f);
            sb.Append(" " + rest);
            return sb.ToString();
        }

        public RunResult RunDocker(string args, int timeoutMs, Action<string> onLine)
        {
            return Proc.Run(Docker, args, Root, timeoutMs, onLine, null);
        }

        public string Get(string key)
        {
            string v;
            return Env.TryGetValue(key, out v) ? v : null;
        }

        public string PublicOrigin()
        {
            string origins = Get("ALLOWED_ORIGINS") ?? "";
            string first = origins.Split(',')[0].Trim().TrimEnd('/');
            return first.Length > 0 ? first : "https://karobakbak.com";
        }

        public string Container(string service) { return Project + "-" + service + "-1"; }

        // Walks up from the exe until it finds the repository. The exe is built
        // into ops\laptop\, so this is normally two levels.
        public static string FindRoot()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            for (int i = 0; i < 8 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir, "docker-compose.laptop.yml"))) return dir;
                DirectoryInfo parent = Directory.GetParent(dir.TrimEnd('\\'));
                dir = parent == null ? null : parent.FullName;
            }
            string pointer = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "karobakbak-live.path");
            if (File.Exists(pointer))
            {
                string p = File.ReadAllText(pointer).Trim();
                if (File.Exists(Path.Combine(p, "docker-compose.laptop.yml"))) return p;
            }
            return null;
        }

        public void LoadEnv()
        {
            Env = new Dictionary<string, string>();
            EnvRaw = File.ReadAllText(EnvPath);
            foreach (string rawLine in EnvRaw.Split('\n'))
            {
                string line = rawLine.TrimEnd('\r').Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim();
                string value = line.Substring(eq + 1).Trim();
                if (value.Length >= 2 &&
                    ((value[0] == '"' && value[value.Length - 1] == '"') ||
                     (value[0] == '\'' && value[value.Length - 1] == '\'')))
                {
                    value = value.Substring(1, value.Length - 2);
                }
                Env[key] = value; // last assignment wins, as in compose
            }
        }
    }

    // -----------------------------------------------------------------------
    // Pre-checks
    // -----------------------------------------------------------------------
    static class PreChecks
    {
        const string Doc = "LAPTOP-HOSTING.md";

        // startDocker: whether a stopped Docker Desktop may be started. False
        // for --check, which must not change anything.
        public static List<CheckResult> Run(Deployment d, bool startDocker, Action<CheckResult> report,
                                            Action<string> log)
        {
            var all = new List<CheckResult>();
            Action<string, Level, string> add = delegate (string n, Level l, string detail)
            {
                var r = new CheckResult(n, l, detail);
                all.Add(r);
                if (report != null) report(r);
            };

            // ---- the repository and its configuration ----------------------
            if (d.Root == null)
            {
                add("Repository", Level.Fail,
                    "docker-compose.laptop.yml not found above this exe. Keep the exe inside the repository " +
                    "(build.ps1 puts it in ops\\laptop\\), or put the repository path in karobakbak-live.path next to it.");
                return all;
            }
            var missingFiles = Deployment.ComposeFiles.Where(f => !File.Exists(Path.Combine(d.Root, f))).ToList();
            if (missingFiles.Count > 0)
            {
                add("Repository", Level.Fail, "Missing: " + string.Join(", ", missingFiles));
                return all;
            }
            add("Repository", Level.Pass, d.Root);

            if (!File.Exists(d.EnvPath))
            {
                add("Configuration file", Level.Fail,
                    ".env.laptop does not exist. Copy .env.laptop.example and fill it in (" + Doc + " step 5).");
                return all;
            }
            try { d.LoadEnv(); }
            catch (Exception ex)
            {
                add("Configuration file", Level.Fail, "Could not read .env.laptop: " + ex.Message);
                return all;
            }
            add("Configuration file", Level.Pass, ".env.laptop, " + d.Env.Count + " settings");

            if (d.EnvRaw.IndexOf('\r') >= 0)
            {
                add("Line endings", Level.Fail,
                    ".env.laptop has Windows (CRLF) line endings, which carry an invisible character into every " +
                    "value. In VS Code click CRLF in the status bar, choose LF, save (" + Doc + " step 5.4).");
            }
            else add("Line endings", Level.Pass, "LF");

            string self = d.Get("APP_ENV_FILE");
            if (self != Deployment.EnvFileName)
                add("Names itself", Level.Fail,
                    "APP_ENV_FILE is '" + (self ?? "unset") + "'; it must be .env.laptop or the containers read another file.");
            else add("Names itself", Level.Pass, "APP_ENV_FILE=.env.laptop");

            // Every ${NAME:?...} in the files compose will read. Read from the
            // files rather than listed here, so a variable added later is
            // checked without anybody remembering to add it.
            var required = new SortedSet<string>();
            foreach (string f in Deployment.ComposeFiles)
            {
                string text = File.ReadAllText(Path.Combine(d.Root, f));
                foreach (Match m in Regex.Matches(text, @"\$\{([A-Z][A-Z0-9_]*):\?"))
                {
                    if (m.Groups[1].Value != "VAR") required.Add(m.Groups[1].Value);
                }
            }
            var empty = required.Where(k => string.IsNullOrEmpty(d.Get(k))).ToList();
            if (empty.Count > 0)
                add("Required settings", Level.Fail, "Empty in .env.laptop: " + string.Join(", ", empty) + " (" + Doc + " step 5).");
            else add("Required settings", Level.Pass, required.Count + " required values present");

            var placeholders = d.Env.Where(kv => kv.Value.Contains("CHANGE_ME")).Select(kv => kv.Key).ToList();
            if (placeholders.Count > 0)
                add("Placeholders", Level.Fail, "Still CHANGE_ME: " + string.Join(", ", placeholders) + " (" + Doc + " step 5.2).");
            else add("Placeholders", Level.Pass, "none left");

            string salt = d.Get("IP_HASH_SALT") ?? "";
            if (salt.Length < 32 || salt.Contains("change-me") || salt.Contains("not-for-production"))
                add("IP hash salt", Level.Fail, "IP_HASH_SALT must be a long random value (openssl rand -hex 32, step 5.2).");
            else add("IP hash salt", Level.Pass, salt.Length + " characters");

            if ((d.Get("AUTH_ENABLED") ?? "").ToLowerInvariant() == "true")
            {
                string[] authKeys = { "AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_CLIENT_ID", "AUTH_CLIENT_SECRET", "AUTH_REDIRECT_URI" };
                var missingAuth = authKeys.Where(k => string.IsNullOrEmpty(d.Get(k))).ToList();
                if (missingAuth.Count > 0)
                    add("Sign-in settings", Level.Fail,
                        "AUTH_ENABLED=true but empty: " + string.Join(", ", missingAuth) +
                        ". The backend refuses to start half-configured (step 5.3, SIGNIN-SETUP.md).");
                else add("Sign-in settings", Level.Pass, "complete");

                // The provider sends people back to AUTH_REDIRECT_URI, so it must
                // be this site's own origin. The auth block is naturally copied
                // from the development .env, and on the first live start that
                // carried ***REMOVED*** along: sign-in completed at Google
                // and landed on a tunnel that was not running (error 1033).
                // Nothing else fails, so nothing else catches it.
                string redirect = d.Get("AUTH_REDIRECT_URI") ?? "";
                string expected = d.PublicOrigin() + "/auth/callback";
                if (redirect.Length > 0 && redirect != expected)
                    add("Sign-in return address", Level.Fail,
                        "AUTH_REDIRECT_URI is " + redirect + " but this site is " + d.PublicOrigin() +
                        ". Sign-in would finish somewhere else. Set it to " + expected + " (step 5.3).");
                else if (redirect.Length > 0) add("Sign-in return address", Level.Pass, redirect);
            }
            else add("Sign-in settings", Level.Warn,
                "AUTH_ENABLED is not true, but the site's sign-in button is compiled in - it will lead to a 404.");

            string token = d.Get("CLOUDFLARE_TUNNEL_TOKEN") ?? "";
            if (token.Length > 0 && !(token.StartsWith("eyJ") && token.Length > 100))
                add("Tunnel token", Level.Warn,
                    "CLOUDFLARE_TUNNEL_TOKEN does not look like a token (they start eyJ and are long). Copy only the value after --token (step 4.1).");
            else if (token.Length > 0) add("Tunnel token", Level.Pass, "present");

            string hops = d.Get("TRUST_PROXY_HOPS");
            if (hops != "2")
                add("Proxy hops", Level.Warn,
                    "TRUST_PROXY_HOPS is " + (hops ?? "unset") + "; the derived value behind the tunnel is 2. Only change it after measuring (step 10.2).");
            else add("Proxy hops", Level.Pass, "2");

            if (string.IsNullOrEmpty(d.Get("MAX_CONNECTIONS")))
                add("Connection ceiling", Level.Warn,
                    "MAX_CONNECTIONS is unset, so the backend derives 11,200 from cores it cannot use. Set 2500.");
            else add("Connection ceiling", Level.Pass, d.Get("MAX_CONNECTIONS"));

            // ---- backups ---------------------------------------------------
            CheckSecretFile(d, add, "ops\\backup\\passphrase", "Backup passphrase", 44);
            CheckSecretFile(d, add, "ops\\backup\\report-token", "Backup report token", 32);

            string rclone = Path.Combine(d.Root, "ops\\backup\\rclone.conf");
            if (Directory.Exists(rclone))
                add("Backup storage key", Level.Fail,
                    "ops\\backup\\rclone.conf is a DIRECTORY - Docker created it when the file was missing. Delete it and write the file (step 6.1).");
            else if (!File.Exists(rclone))
                add("Backup storage key", Level.Fail, "ops\\backup\\rclone.conf is missing (step 6.1).");
            else
            {
                // BACKUP_REMOTE is "<remote>:<bucket>"; that remote has to be a
                // section in rclone.conf or every upload fails. A leftover
                // rehearsal config ([drill], the MinIO stand-in) is the likely
                // way to get this wrong, and backups then never leave the laptop.
                string remote = (d.Get("BACKUP_REMOTE") ?? "").Split(':')[0];
                var sections = Regex.Matches(File.ReadAllText(rclone), @"^\[([^\]]+)\]", RegexOptions.Multiline)
                                    .Cast<Match>().Select(m => m.Groups[1].Value).ToList();
                if (remote.Length > 0 && !sections.Contains(remote))
                    add("Backup storage key", Level.Fail,
                        "BACKUP_REMOTE uses '" + remote + ":' but rclone.conf only defines [" + string.Join("], [", sections) +
                        "]. Write the R2 credentials as [" + remote + "] (step 6.1), or no backup leaves this laptop.");
                else add("Backup storage key", Level.Pass, "rclone.conf defines [" + remote + "]");
            }

            string tokenFile = Path.Combine(d.Root, "ops\\backup\\report-token");
            if (File.Exists(tokenFile))
            {
                string fileToken = File.ReadAllText(tokenFile);
                if (fileToken != (d.Get("BACKUP_REPORT_TOKEN") ?? ""))
                    add("Backup token matches", Level.Fail,
                        "BACKUP_REPORT_TOKEN in .env.laptop differs from ops\\backup\\report-token. Backups would succeed unobserved (step 6.3).");
                else add("Backup token matches", Level.Pass, "file and setting agree");
            }

            if (string.IsNullOrEmpty(d.Get("BACKUP_REMOTE")))
                add("Backup destination", Level.Warn, "BACKUP_REMOTE is empty: backups would stay on this laptop only.");
            else add("Backup destination", Level.Pass, d.Get("BACKUP_REMOTE"));

            // ---- alerts ----------------------------------------------------
            string hook = Path.Combine(d.Root, "monitoring\\alertmanager\\webhook-url");
            if (Directory.Exists(hook))
                add("Alert delivery", Level.Fail, "monitoring\\alertmanager\\webhook-url is a directory. Delete it and write the URL (step 7).");
            else if (!File.Exists(hook) || !File.ReadAllText(hook).Trim().StartsWith("http"))
                add("Alert delivery", Level.Warn, "monitoring\\alertmanager\\webhook-url is missing or not a URL: every alert fires into nothing (step 7).");
            else add("Alert delivery", Level.Pass, "webhook configured");

            // ---- the machine -----------------------------------------------
            try
            {
                string dockerDrive = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
                var drive = new DriveInfo(dockerDrive);
                double freeGb = drive.AvailableFreeSpace / 1073741824.0;
                Level l = freeGb < 3 ? Level.Fail : freeGb < 10 ? Level.Warn : Level.Pass;
                add("Disk space", l, string.Format("{0:0.0} GB free on {1} (Docker's disk image lives there)", freeGb, dockerDrive));
            }
            catch (Exception ex) { add("Disk space", Level.Warn, "Could not read: " + ex.Message); }

            PowerLineStatus power = SystemInformation.PowerStatus.PowerLineStatus;
            if (power == PowerLineStatus.Offline)
                add("Power", Level.Warn, "Running on battery. Windows sleeps on its battery settings, which takes the site down.");
            else add("Power", Level.Pass, power == PowerLineStatus.Online ? "on mains" : "unknown (no battery?)");

            add("Cloudflare reachable", ReachCloudflare() ? Level.Pass : Level.Warn,
                ReachCloudflare() ? "region1.v2.argotunnel.com:7844 answered"
                                  : "Could not reach Cloudflare's tunnel endpoint. The site will be unreachable until the connection works.");

            // ---- Docker ----------------------------------------------------
            if (d.Docker == null)
            {
                add("Docker", Level.Fail, "docker.exe not found. Install Docker Desktop.");
                return all;
            }

            string settings = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                                           @"Docker\settings-store.json");
            if (File.Exists(settings))
            {
                string json = File.ReadAllText(settings);
                if (Regex.IsMatch(json, "\"AutoStart\"\\s*:\\s*false"))
                    add("Docker starts at sign-in", Level.Warn,
                        "Docker Desktop does not start when you sign in, so a restart leaves the site down until you open this app. " +
                        "Docker Desktop > Settings > General > Start Docker Desktop when you sign in (step 2.1).");
                else add("Docker starts at sign-in", Level.Pass, "on");
                if (Regex.IsMatch(json, "\"AutoDownloadUpdates\"\\s*:\\s*true"))
                    add("Docker auto-update", Level.Warn,
                        "Docker Desktop downloads updates by itself; installing one restarts the site. Settings > Software updates (step 2.1).");
            }

            RunResult info = d.RunDocker("info --format \"{{.OSType}}|{{.MemTotal}}|{{.NCPU}}\"", 30000, null);
            if (info.ExitCode != 0)
            {
                if (!startDocker)
                {
                    add("Docker engine", Level.Fail, "Docker Desktop is not running (the app starts it; --check does not).");
                    return all;
                }
                if (log != null) log("Docker Desktop is not running - starting it.");
                if (!StartDockerDesktop(d, log))
                {
                    add("Docker engine", Level.Fail, "Docker Desktop did not become ready within three minutes.");
                    return all;
                }
                info = d.RunDocker("info --format \"{{.OSType}}|{{.MemTotal}}|{{.NCPU}}\"", 30000, null);
            }
            string[] parts = info.Output.Trim().Split('|');
            if (parts.Length < 3 || parts[0] != "linux")
            {
                add("Docker engine", Level.Fail, "Docker is in Windows-containers mode. Switch to Linux containers from the tray menu.");
                return all;
            }
            long memBytes;
            long.TryParse(parts[1], out memBytes);
            double memGb = memBytes / 1073741824.0;
            add("Docker engine", Level.Pass, string.Format("running, {0} CPUs, {1:0.0} GB", parts[2], memGb));
            if (memGb < 4)
                add("Docker memory", Level.Warn,
                    string.Format("Docker has {0:0.0} GB; the live stack's ceilings total about 4 GB. Raise memory= in .wslconfig.", memGb));

            RunResult cfg = d.RunDocker(d.Compose("config --quiet"), 60000, null);
            if (cfg.ExitCode != 0)
                add("Compose renders", Level.Fail, FirstLines(cfg.Output, 4));
            else add("Compose renders", Level.Pass, "three files, project " + Deployment.Project);

            // Ports: Grafana is the only one the live stack publishes by
            // default. Busy is fine when it is our own Grafana holding it.
            RunResult running = d.RunDocker("ps --format \"{{.Names}}\"", 30000, null);
            var names = new HashSet<string>(running.Output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
            string grafanaPort = d.Get("GRAFANA_PORT") ?? "3010";
            int port;
            if (int.TryParse(grafanaPort, out port) && !PortFree(port) && !names.Contains(d.Container("grafana")))
                add("Grafana port", Level.Fail,
                    "127.0.0.1:" + port + " is held by something other than the live Grafana, so the stack cannot start. " +
                    "Free it or set GRAFANA_PORT (and GRAFANA_ROOT_URL) in .env.laptop.");
            else add("Grafana port", Level.Pass, port + " available");

            int live = names.Count(n => n.StartsWith(Deployment.Project + "-"));
            int dev = names.Count(n => n.StartsWith("karobakbak-dev-") || n.StartsWith("karobakbak-loadtest-"));
            add("Current state", Level.Info,
                live > 0 ? live + " live containers already running; starting again applies any changes"
                         : "the live stack is not running");
            if (dev > 0)
                add("Other stacks", Level.Info,
                    dev + " development or load-test containers are running and share the CPU with the live site.");

            // ---- the code being served ------------------------------------
            string git = Proc.FindOnPath("git.exe");
            if (git != null)
            {
                RunResult branch = Proc.Run(git, "rev-parse --abbrev-ref HEAD", d.Root, 15000, null, null);
                RunResult dirty = Proc.Run(git, "status --porcelain --untracked-files=no", d.Root, 15000, null, null);
                string b = branch.Output.Trim();
                bool isDirty = dirty.Output.Trim().Length > 0;
                if (b != "main" || isDirty)
                    add("Code being served", Level.Warn,
                        "The site is built from this working tree: branch '" + b + "'" +
                        (isDirty ? " with uncommitted changes" : "") + ". Production normally runs main.");
                else add("Code being served", Level.Pass, "main, clean");
            }

            return all;
        }

        static void CheckSecretFile(Deployment d, Action<string, Level, string> add, string rel, string name, int expectedBytes)
        {
            string path = Path.Combine(d.Root, rel);
            if (Directory.Exists(path))
            {
                add(name, Level.Fail, rel + " is a DIRECTORY - Docker created it when the file was missing. Delete it and generate the file (step 6.2).");
                return;
            }
            if (!File.Exists(path))
            {
                add(name, Level.Fail, rel + " is missing (step 6.2).");
                return;
            }
            byte[] bytes = File.ReadAllBytes(path);
            if (bytes.Contains((byte)'\r') || bytes.Contains((byte)'\n'))
            {
                add(name, Level.Fail,
                    rel + " ends with a newline or carriage return, which becomes part of the secret (F-049). " +
                    "Regenerate it in Git Bash with printf %s (step 6.2).");
                return;
            }
            if (bytes.Length != expectedBytes)
                add(name, Level.Warn, rel + " is " + bytes.Length + " bytes; step 6.2 produces " + expectedBytes + ".");
            else add(name, Level.Pass, bytes.Length + " bytes, no line ending");
        }

        static bool cloudflareCache;
        static bool cloudflareChecked;

        static bool ReachCloudflare()
        {
            if (cloudflareChecked) return cloudflareCache;
            cloudflareChecked = true;
            try
            {
                using (var client = new TcpClient())
                {
                    IAsyncResult ar = client.BeginConnect("region1.v2.argotunnel.com", 7844, null, null);
                    cloudflareCache = ar.AsyncWaitHandle.WaitOne(6000) && client.Connected;
                }
            }
            catch { cloudflareCache = false; }
            return cloudflareCache;
        }

        static bool PortFree(int port)
        {
            try
            {
                var l = new TcpListener(IPAddress.Loopback, port);
                l.Start();
                l.Stop();
                return true;
            }
            catch (SocketException) { return false; }
        }

        public static bool StartDockerDesktop(Deployment d, Action<string> log)
        {
            string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                                      @"Docker\Docker\Docker Desktop.exe");
            if (!File.Exists(exe)) return false;
            try { Process.Start(exe); } catch { return false; }
            DateTime deadline = DateTime.Now.AddMinutes(3);
            while (DateTime.Now < deadline)
            {
                Thread.Sleep(3000);
                if (d.RunDocker("info --format \"{{.OSType}}\"", 15000, null).ExitCode == 0)
                {
                    if (log != null) log("Docker Desktop is ready.");
                    return true;
                }
            }
            return false;
        }

        public static string FirstLines(string text, int n)
        {
            var lines = text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Take(n);
            return string.Join(" | ", lines);
        }
    }

    // -----------------------------------------------------------------------
    // Starting, stopping, and deciding whether it is live
    // -----------------------------------------------------------------------
    static class Operations
    {
        public static bool Start(Deployment d, Action<string> log, Action<string> stage)
        {
            stage("Building and starting...");
            log("> docker " + d.Compose("up -d --build"));
            RunResult up = d.RunDocker(d.Compose("up -d --build"), 30 * 60 * 1000, log);
            if (up.ExitCode != 0)
            {
                log("FAILED: docker compose up exited " + up.ExitCode + (up.TimedOut ? " (timed out)" : "") + ".");
                return false;
            }

            stage("Waiting for migrations...");
            if (!WaitForMigrate(d, log)) return false;

            stage("Checking the database role...");
            if (!EnsureAppRole(d, log)) return false;

            stage("Waiting for services...");
            if (!WaitForServices(d, log)) return false;

            stage("Waiting for the tunnel...");
            if (!WaitForTunnel(d, log)) return false;

            stage("Asking the public site...");
            if (!WaitForPublic(d, log)) return false;

            Personas.ResumeIfOn(d, log);
            return true;
        }

        static bool WaitForMigrate(Deployment d, Action<string> log)
        {
            DateTime deadline = DateTime.Now.AddMinutes(3);
            string state = "";
            while (DateTime.Now < deadline)
            {
                state = d.RunDocker(d.Compose("ps -a migrate --format \"{{.State}} {{.ExitCode}}\""), 30000, null).Output.Trim();
                if (state.StartsWith("exited")) break;
                Thread.Sleep(2000);
            }
            if (state == "exited 0")
            {
                log("migrate: exited 0.");
                return true;
            }
            log("FAILED: migrate is '" + state + "'. With no schema every other container still looks healthy. Its log:");
            log(d.RunDocker("logs --tail 15 " + d.Container("migrate"), 30000, null).Output);
            log("GOING-LIVE.md C1 lists what each cause looks like.");
            return false;
        }

        // karobakbak_app is created with no password on purpose (002_roles.sql).
        // On a fresh database it cannot log in until the deployment gives it
        // the one in DATABASE_URL - LAPTOP-HOSTING step 8.4, done here so it
        // cannot be forgotten. Also repairs a password that disagrees with the
        // config, which the backend reports as an authentication failure.
        static bool EnsureAppRole(Deployment d, Action<string> log)
        {
            string user = d.Get("POSTGRES_USER") ?? "karobakbak";
            string db = d.Get("POSTGRES_DB") ?? "karobakbak";
            string pg = d.Container("postgres");

            RunResult canLogin = d.RunDocker(
                "exec " + pg + " psql -U " + user + " -d " + db +
                " -tAc \"select rolcanlogin from pg_roles where rolname='karobakbak_app'\"", 30000, null);
            string answer = canLogin.Output.Trim();

            bool needsPassword = answer == "f";
            if (answer == "t")
            {
                string backendLog = d.RunDocker("logs --tail 300 " + d.Container("backend"), 30000, null).Output;
                needsPassword = backendLog.Contains("password authentication failed for user \"karobakbak_app\"");
                if (!needsPassword)
                {
                    log("karobakbak_app: can log in.");
                    return true;
                }
                log("The backend reports a wrong password for karobakbak_app - setting it from DATABASE_URL.");
            }
            else if (answer != "f")
            {
                log("FAILED: could not ask PostgreSQL about karobakbak_app: " + PreChecks.FirstLines(canLogin.Output, 3));
                return false;
            }
            else log("First start: karobakbak_app has no password yet - setting it from DATABASE_URL (step 8.4).");

            Match m = Regex.Match(d.Get("DATABASE_URL") ?? "", @"^postgres(?:ql)?://karobakbak_app:([^@]+)@");
            if (!m.Success)
            {
                log("FAILED: DATABASE_URL does not have the shape postgres://karobakbak_app:<password>@...");
                return false;
            }
            string password = m.Groups[1].Value;
            if (!Regex.IsMatch(password, "^[A-Za-z0-9]+$"))
            {
                log("FAILED: the password in DATABASE_URL is not plain letters and digits. Step 5.2 generates hex; " +
                    "set it by hand as in step 8.4.");
                return false;
            }

            // Over stdin, so the password is in neither a process list nor this log.
            RunResult alter = Proc.Run(d.Docker, "exec -i " + pg + " psql -v ON_ERROR_STOP=1 -U " + user + " -d " + db,
                                       d.Root, 30000, null,
                                       "alter role karobakbak_app with login password '" + password + "';\n");
            if (alter.ExitCode != 0 || !alter.Output.Contains("ALTER ROLE"))
            {
                log("FAILED: could not set the password: " + PreChecks.FirstLines(alter.Output, 3));
                return false;
            }
            log("ALTER ROLE - restarting the backend so it connects.");
            d.RunDocker("restart " + d.Container("backend"), 120000, null);
            return true;
        }

        static bool WaitForServices(Deployment d, Action<string> log)
        {
            DateTime deadline = DateTime.Now.AddMinutes(3);
            List<string> problems = new List<string>();
            while (DateTime.Now < deadline)
            {
                problems.Clear();
                string table = d.RunDocker(d.Compose("ps -a --format \"{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}\""), 30000, null).Output;
                int seen = 0;
                foreach (string row in table.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string[] c = row.Split('|');
                    if (c.Length < 4) continue;
                    seen++;
                    string svc = c[0], state = c[1], health = c[2];
                    if (svc == "migrate") continue;
                    if (state != "running") problems.Add(svc + " is " + state + (state == "exited" ? " (" + c[3] + ")" : ""));
                    else if (health == "starting") problems.Add(svc + " is starting");
                    else if (health == "unhealthy") problems.Add(svc + " is unhealthy");
                }
                if (seen > 0 && problems.Count == 0)
                {
                    log("All " + (seen - 1) + " services running.");
                    return true;
                }
                Thread.Sleep(3000);
            }
            log("FAILED: after three minutes: " + string.Join("; ", problems) + ".");
            log("An exit code of 137 means a memory ceiling was hit - raise that service's limit in docker-compose.laptop.yml.");
            return false;
        }

        static bool WaitForTunnel(Deployment d, Action<string> log)
        {
            DateTime deadline = DateTime.Now.AddSeconds(90);
            while (DateTime.Now < deadline)
            {
                string cf = d.RunDocker("logs --tail 200 " + d.Container("cloudflared"), 30000, null).Output;
                if (cf.Contains("Registered tunnel connection"))
                {
                    log("Tunnel: registered with Cloudflare.");
                    return true;
                }
                if (cf.Contains("Unauthorized") || cf.Contains("Invalid tunnel secret") || cf.Contains("invalid token"))
                {
                    log("FAILED: Cloudflare refused the tunnel token. Copy it again from Zero Trust > Networks > Tunnels (step 4.1).");
                    return false;
                }
                Thread.Sleep(3000);
            }
            log("FAILED: cloudflared did not register within 90 seconds. Its last lines:");
            log(d.RunDocker("logs --tail 10 " + d.Container("cloudflared"), 30000, null).Output);
            return false;
        }

        static bool WaitForPublic(Deployment d, Action<string> log)
        {
            string url = d.PublicOrigin() + "/ready";
            DateTime deadline = DateTime.Now.AddMinutes(2);
            int last = 0;
            while (DateTime.Now < deadline)
            {
                last = HttpStatus(url, true);
                if (last == 200)
                {
                    log(url + " answered 200 through Cloudflare and the tunnel.");
                    CheckSignIn(d, log);
                    return true;
                }
                Thread.Sleep(4000);
            }
            log("FAILED: " + url + " last answered " + (last == 0 ? "nothing" : last.ToString()) + ".");
            log("1033 = tunnel not connected; 502 = the tunnel's service is not http://frontend:80 (step 4.2).");
            return false;
        }

        // Sign-in is a button on every page, so prove it reaches the provider,
        // and that the profile scope is asked for when avatars are on.
        static void CheckSignIn(Deployment d, Action<string> log)
        {
            if ((d.Get("AUTH_ENABLED") ?? "").ToLowerInvariant() != "true") return;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(d.PublicOrigin() + "/auth/start");
                req.AllowAutoRedirect = false;
                req.Timeout = 15000;
                using (var resp = GetResponse(req))
                {
                    string location = resp.Headers["Location"] ?? "";
                    if ((int)resp.StatusCode != 302 || location.Length == 0)
                        log("WARNING: /auth/start answered " + (int)resp.StatusCode + " - sign-in is not reaching the provider.");
                    else if ((d.Get("AUTH_AVATARS") ?? "") == "true" && !location.Contains("scope=openid+email+profile"))
                        log("WARNING: sign-in does not ask for the profile scope; AUTH_AVATARS did not arrive.");
                    else log("Sign-in: redirects to the provider.");
                }
            }
            catch (Exception ex) { log("WARNING: could not check sign-in: " + ex.Message); }
        }

        static HttpWebResponse GetResponse(HttpWebRequest req)
        {
            try { return (HttpWebResponse)req.GetResponse(); }
            catch (WebException ex)
            {
                if (ex.Response != null) return (HttpWebResponse)ex.Response;
                throw;
            }
        }

        public static int HttpStatus(string url, bool noCache)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 10000;
                req.AllowAutoRedirect = false;
                if (noCache) req.Headers.Add("Cache-Control", "no-cache");
                using (var resp = GetResponse(req)) return (int)resp.StatusCode;
            }
            catch { return 0; }
        }

        public static bool Stop(Deployment d, Action<string> log)
        {
            // --profile personas, so the persona container goes too: with the
            // backend gone it could only fail to reconnect. Start brings it
            // back if its switch is still on.
            log("> docker " + d.Compose("--profile personas down"));
            RunResult down = d.RunDocker(d.Compose("--profile personas down"), 5 * 60 * 1000, log);
            if (down.ExitCode != 0)
            {
                log("FAILED: docker compose down exited " + down.ExitCode + ".");
                return false;
            }
            log("Stopped. Data volumes are kept.");
            return true;
        }
    }

    // -----------------------------------------------------------------------
    // AI personas: one on/off switch
    // -----------------------------------------------------------------------
    // Two things decide whether personas join conversations, and both must say
    // yes (docs/AI-PERSONAS.md): the `personas` container, which sits behind a
    // compose profile, and the global row of `persona_control` in PostgreSQL,
    // which ships disabled. "On" here means both. The switch writes the row as
    // the database superuser with updated_by/reason, the same as the SQL route
    // in PERSONA-SETUP.md; the moderation console is the audited route.
    sealed class PersonaStatus
    {
        public bool Known;          // false when PostgreSQL could not be asked
        public bool SwitchOn;
        public string Mode = "";
        public bool ContainerRunning;
        public string ContainerState = "absent";
        public long Spent;
        public long Limit;          // 0 = no spend row yet this month
        public int Open;
        public string Hours = "";

        public bool IsOn { get { return SwitchOn && ContainerRunning; } }

        public static string Dollars(long microCents)
        {
            return "$" + (microCents / 100000000.0).ToString("0.00");
        }

        public string Describe()
        {
            if (!Known) return "Personas: state unknown (database not answering)";
            var parts = new List<string>();
            if (IsOn) parts.Add("on");
            else if (SwitchOn) parts.Add("switched on, container " + ContainerState);
            else parts.Add(ContainerRunning ? "off (draining)" : "off");
            if (IsOn || Open > 0) parts.Add(Open + (Open == 1 ? " conversation" : " conversations"));
            parts.Add(Dollars(Spent) + (Limit > 0 ? " of " + Dollars(Limit) : "") + " this month");
            if (Hours.Length > 0) parts.Add(Hours);
            return "Personas: " + string.Join("  \u00B7  ", parts);
        }
    }

    static class Personas
    {
        // A read uses -c; a write goes over stdin so its text is never on a
        // command line.
        static string Sql(Deployment d, string read, string write)
        {
            string user = d.Get("POSTGRES_USER") ?? "karobakbak";
            string db = d.Get("POSTGRES_DB") ?? "karobakbak";
            if (write != null)
            {
                RunResult w = Proc.Run(d.Docker, "exec -i " + d.Container("postgres") + " psql -v ON_ERROR_STOP=1 -U " + user + " -d " + db,
                                       d.Root, 30000, null, write);
                return w.ExitCode == 0 ? w.Output : null;
            }
            RunResult r = d.RunDocker("exec " + d.Container("postgres") + " psql -tA -U " + user + " -d " + db + " -c \"" + read + "\"", 30000, null);
            return r.ExitCode == 0 ? r.Output : null;
        }

        static string Inspect(Deployment d)
        {
            return d.RunDocker("inspect -f \"{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}\" " +
                               d.Container("personas"), 15000, null).Output.Trim();
        }

        public static PersonaStatus Status(Deployment d)
        {
            var st = new PersonaStatus();
            string state = Inspect(d);
            if (state.Contains("|") && !state.StartsWith("Error"))
            {
                string[] c = state.Split('|');
                st.ContainerState = c[1].Length > 0 ? c[0] + ", " + c[1] : c[0];
                st.ContainerRunning = c[0] == "running" && c[1] != "unhealthy";
            }

            string row = Sql(d,
                "select (select enabled::text || ',' || mode from persona_control where scope = 'global' and subject = ''), " +
                "coalesce((select spent_micro_cents || ',' || limit_micro_cents from persona_spend order by period desc limit 1), '0,0'), " +
                "(select count(*) from persona_conversations where ended_at is null)", null);
            if (row != null)
            {
                string[] c = row.Trim().Split('|');
                if (c.Length == 3)
                {
                    string[] sw = c[0].Split(',');
                    string[] sp = c[1].Split(',');
                    st.SwitchOn = sw[0] == "true";
                    st.Mode = sw.Length > 1 ? sw[1] : "";
                    long.TryParse(sp[0], out st.Spent);
                    if (sp.Length > 1) long.TryParse(sp[1], out st.Limit);
                    int.TryParse(c[2], out st.Open);
                    st.Known = true;
                }
            }

            string start = d.Get("PERSONA_ACTIVE_START_HOUR") ?? "0", end = d.Get("PERSONA_ACTIVE_END_HOUR") ?? "0";
            st.Hours = (start == "0" && end == "0") ? "active all day"
                     : "active " + start.PadLeft(2, '0') + ":00-" + end.PadLeft(2, '0') + ":00";
            return st;
        }

        public static bool TurnOn(Deployment d, Action<string> log)
        {
            // ---- pre-checks: the things that fail quietly ------------------
            string provider = d.Get("PERSONA_PROVIDER") ?? "";
            string model = d.Get("PERSONA_MODEL") ?? "";
            if (provider.Length == 0 || model.Length == 0)
            {
                log("FAILED: PERSONA_PROVIDER and PERSONA_MODEL must be set in .env.laptop (PERSONA-SETUP.md step 2).");
                return false;
            }
            if (string.IsNullOrEmpty(d.Get("PERSONA_API_KEY")))
                log("NOTE: PERSONA_API_KEY is empty - personas will use the scripted voice (greets, cannot follow a conversation; costs nothing).");

            int concurrent;
            if (!int.TryParse(d.Get("PERSONA_MAX_CONCURRENT") ?? "4", out concurrent)) concurrent = 4;
            if (concurrent >= 40)
            {
                log("FAILED: PERSONA_MAX_CONCURRENT is " + concurrent + ". Every persona connects from one address and " +
                    "MAX_CONNECTIONS_PER_IP is 40 in production, so the cap must stay below it.");
                return false;
            }

            // The base compose file hardcodes development database credentials
            // for this service; docker-compose.prod.yml must replace them, or
            // every query fails with 28P01.
            RunResult cfg = d.RunDocker(d.Compose("--profile personas config personas"), 60000, null);
            if (cfg.ExitCode != 0)
            {
                log("FAILED: compose refuses the personas configuration: " + PreChecks.FirstLines(cfg.Output, 3));
                return false;
            }
            if (cfg.Output.Contains("karobakbak:karobakbak@postgres") || cfg.Output.Contains("NODE_ENV: development"))
            {
                log("FAILED: the personas service would get development database credentials. docker-compose.prod.yml " +
                    "needs its personas override (on main since the personas fix - pull and try again).");
                return false;
            }
            log("Persona settings: " + provider + " / " + model + ", at most " + concurrent + " at once.");

            // ---- the container -----------------------------------------------
            log("> docker " + d.Compose("--profile personas up -d --build personas"));
            RunResult up = d.RunDocker(d.Compose("--profile personas up -d --build personas"), 20 * 60 * 1000, log);
            if (up.ExitCode != 0)
            {
                log("FAILED: starting the personas container exited " + up.ExitCode + ".");
                return false;
            }

            DateTime deadline = DateTime.Now.AddSeconds(90);
            string health = "";
            while (DateTime.Now < deadline)
            {
                health = Inspect(d);
                if (health.StartsWith("running|healthy") || health.StartsWith("exited") || health.StartsWith("restarting")) break;
                Thread.Sleep(3000);
            }
            string tail = d.RunDocker("logs --tail 60 " + d.Container("personas"), 30000, null).Output;
            if (tail.Contains("28P01") || tail.Contains("auth_failed"))
            {
                log("FAILED: the personas container cannot log in to PostgreSQL (28P01). PERSONA-SETUP.md, troubleshooting.");
                return false;
            }
            if (!health.StartsWith("running|healthy"))
            {
                log("FAILED: the personas container is '" + health + "'. Its last lines:");
                var lines = tail.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                foreach (string line in lines.Skip(Math.Max(0, lines.Length - 12))) log("  " + line);
                return false;
            }
            log("Personas container: running and healthy.");

            // ---- the switch ----------------------------------------------------
            string res = Sql(d, null,
                "update persona_control set enabled = true, mode = 'drain', updated_by = 'karobakbak-live app', " +
                "reason = 'Turned on from the launcher', updated_at = now() where scope = 'global' and subject = '';\n");
            if (res == null || !res.Contains("UPDATE 1"))
            {
                log("FAILED: could not turn the switch on in persona_control.");
                return false;
            }
            log("Switch on. Personas join within about 20 seconds, during their active hours, when somebody has waited " +
                (d.Get("PERSONA_WAIT_BEFORE_FILL_SECONDS") ?? "8") + " seconds alone.");
            return true;
        }

        // Drain, not hard: live persona conversations finish, no new ones start.
        // The container stays up so they can finish; it costs nothing idle.
        public static bool TurnOff(Deployment d, Action<string> log)
        {
            string res = Sql(d, null,
                "update persona_control set enabled = false, mode = 'drain', updated_by = 'karobakbak-live app', " +
                "reason = 'Turned off from the launcher', updated_at = now() where scope = 'global' and subject = '';\n");
            if (res == null || !res.Contains("UPDATE 1"))
            {
                log("FAILED: could not turn the switch off in persona_control.");
                return false;
            }
            log("Switch off (drain): conversations already running finish; no new ones start.");
            return true;
        }

        // After the site starts: personas that were switched on come back too.
        public static void ResumeIfOn(Deployment d, Action<string> log)
        {
            PersonaStatus st = Status(d);
            if (!st.Known || !st.SwitchOn || st.ContainerRunning) return;
            log("Personas were switched on - starting their container.");
            RunResult up = d.RunDocker(d.Compose("--profile personas up -d personas"), 20 * 60 * 1000, log);
            if (up.ExitCode != 0) log("WARNING: the personas container did not start; use the Personas button.");
        }
    }

    // -----------------------------------------------------------------------
    // The window
    // -----------------------------------------------------------------------
    sealed class MainForm : Form
    {
        static readonly Color CInk = Color.FromArgb(0x13, 0x10, 0x0b);
        static readonly Color CPanel = Color.FromArgb(0x1d, 0x19, 0x12);
        static readonly Color CAmber = Color.FromArgb(0xff, 0xb4, 0x20);
        static readonly Color CText = Color.FromArgb(0xee, 0xe6, 0xd6);
        static readonly Color CMuted = Color.FromArgb(0x9a, 0x90, 0x7e);
        static readonly Color CGreen = Color.FromArgb(0x6f, 0xd0, 0x8c);
        static readonly Color CRed = Color.FromArgb(0xff, 0x6b, 0x5e);

        readonly Deployment deployment;
        readonly bool autoStart;
        readonly string logFile;

        Label status, sub, personaLine;
        ListView checks;
        TextBox output;
        Button startBtn, stopBtn, checkBtn, siteBtn, grafanaBtn, logBtn, personaBtn;
        PersonaStatus personas;
        System.Windows.Forms.Timer heartbeat;
        volatile bool busy;

        public MainForm(Deployment d, bool autoStart)
        {
            deployment = d;
            this.autoStart = autoStart;
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "karobakbak-live");
            Directory.CreateDirectory(dir);
            logFile = Path.Combine(dir, "launcher.log");

            Text = "karobakbak live";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            BackColor = CInk;
            ForeColor = CText;
            Font = new Font("Segoe UI", 9.5f);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(900, 640);
            MinimumSize = new Size(720, 520);
            StartPosition = FormStartPosition.CenterScreen;

            var header = new Panel { Dock = DockStyle.Top, Height = 100, BackColor = CPanel, Padding = new Padding(18, 12, 18, 10) };
            status = new Label { Text = "Checking...", Font = new Font("Segoe UI Semibold", 16f), ForeColor = CAmber, AutoSize = true, Location = new Point(18, 10) };
            sub = new Label { Text = d.Root ?? "", ForeColor = CMuted, AutoSize = true, Location = new Point(20, 46) };
            personaLine = new Label { Text = "Personas: ...", ForeColor = CMuted, AutoSize = true, Location = new Point(20, 70) };
            header.Controls.Add(status);
            header.Controls.Add(sub);
            header.Controls.Add(personaLine);

            checks = new ListView
            {
                Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, HeaderStyle = ColumnHeaderStyle.Nonclickable,
                BackColor = CInk, ForeColor = CText, BorderStyle = BorderStyle.None, ShowItemToolTips = true
            };
            // Owner-drawn headers only: the stock header is a white bar on a
            // dark window. Rows keep the default drawing.
            checks.OwnerDraw = true;
            checks.DrawColumnHeader += delegate (object o, DrawListViewColumnHeaderEventArgs e)
            {
                using (var bg = new SolidBrush(CPanel)) e.Graphics.FillRectangle(bg, e.Bounds);
                TextRenderer.DrawText(e.Graphics, e.Header.Text, Font, Rectangle.Inflate(e.Bounds, -4, 0), CMuted,
                                      TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
            };
            checks.DrawItem += delegate (object o, DrawListViewItemEventArgs e) { e.DrawDefault = true; };
            checks.DrawSubItem += delegate (object o, DrawListViewSubItemEventArgs e) { e.DrawDefault = true; };
            checks.Columns.Add("", 64);
            checks.Columns.Add("Check", 190);
            checks.Columns.Add("Detail", 600);
            checks.Resize += delegate { checks.Columns[2].Width = Math.Max(200, checks.ClientSize.Width - 64 - 190 - 4); };

            output = new TextBox
            {
                Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
                BackColor = Color.FromArgb(0x0c, 0x0a, 0x07), ForeColor = CText, BorderStyle = BorderStyle.None,
                Font = new Font("Consolas", 9f), WordWrap = true
            };

            var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, BackColor = CPanel, SplitterWidth = 6 };
            split.Panel1.Controls.Add(checks);
            split.Panel2.Controls.Add(output);

            var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 56, BackColor = CPanel, Padding = new Padding(14, 11, 14, 8) };
            startBtn = MakeButton("Start", true);
            stopBtn = MakeButton("Stop", false);
            checkBtn = MakeButton("Run checks", false);
            siteBtn = MakeButton("Open site", false);
            grafanaBtn = MakeButton("Grafana", false);
            logBtn = MakeButton("Log file", false);
            personaBtn = MakeButton("Personas: ...", false);
            personaBtn.Margin = new Padding(14, 0, 10, 0);
            buttons.Controls.AddRange(new Control[] { startBtn, stopBtn, checkBtn, siteBtn, grafanaBtn, logBtn, personaBtn });

            Controls.Add(split);
            Controls.Add(buttons);
            Controls.Add(header);
            Load += delegate { split.SplitterDistance = (int)(split.Height * 0.48); };

            startBtn.Click += delegate { RunStart(); };
            stopBtn.Click += delegate { RunStop(); };
            checkBtn.Click += delegate { RunChecks(false); };
            siteBtn.Click += delegate { Open(d.PublicOrigin()); };
            grafanaBtn.Click += delegate { Open("http://localhost:" + (d.Get("GRAFANA_PORT") ?? "3010")); };
            logBtn.Click += delegate { if (File.Exists(logFile)) Open(logFile); };
            personaBtn.Click += delegate { TogglePersonas(); };

            heartbeat = new System.Windows.Forms.Timer { Interval = 30000 };
            heartbeat.Tick += delegate { Heartbeat(); };
            Shown += delegate { RunChecks(this.autoStart); };
        }

        Button MakeButton(string text, bool primary)
        {
            var b = new Button
            {
                Text = text, AutoSize = true, MinimumSize = new Size(96, 34), FlatStyle = FlatStyle.Flat,
                BackColor = primary ? CAmber : CPanel, ForeColor = primary ? CInk : CText, Margin = new Padding(0, 0, 10, 0),
                Font = new Font("Segoe UI Semibold", 9.5f), Cursor = Cursors.Hand
            };
            b.FlatAppearance.BorderColor = primary ? CAmber : CMuted;
            return b;
        }

        void Open(string target)
        {
            try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
            catch (Exception ex) { Log("Could not open " + target + ": " + ex.Message); }
        }

        // ---- thread-safe UI updates --------------------------------------
        void Ui(Action a)
        {
            if (IsDisposed) return;
            if (InvokeRequired) { try { BeginInvoke(a); } catch (InvalidOperationException) { } }
            else a();
        }

        void Log(string line)
        {
            string stamped = DateTime.Now.ToString("HH:mm:ss") + "  " + line;
            try { File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd ") + stamped + Environment.NewLine); } catch { }
            Ui(delegate
            {
                output.AppendText(stamped + Environment.NewLine);
            });
        }

        void SetStatus(string text, Color color)
        {
            Ui(delegate { status.Text = text; status.ForeColor = color; });
        }

        void SetBusy(bool value)
        {
            busy = value;
            Ui(delegate
            {
                startBtn.Enabled = !value;
                stopBtn.Enabled = !value;
                checkBtn.Enabled = !value;
                personaBtn.Enabled = !value;
                UseWaitCursor = value;
            });
        }

        void AddCheck(CheckResult r)
        {
            Ui(delegate
            {
                string mark = r.Level == Level.Pass ? "PASS" : r.Level == Level.Warn ? "WARN" : r.Level == Level.Fail ? "FAIL" : "INFO";
                var item = new ListViewItem(new[] { mark, r.Name, r.Detail });
                item.ForeColor = r.Level == Level.Pass ? CGreen : r.Level == Level.Warn ? CAmber : r.Level == Level.Fail ? CRed : CMuted;
                item.ToolTipText = r.Detail;
                checks.Items.Add(item);
                item.EnsureVisible();
            });
            // The list truncates; the log does not.
            if (r.Level == Level.Fail || r.Level == Level.Warn)
                Log((r.Level == Level.Fail ? "FAIL  " : "WARN  ") + r.Name + ": " + r.Detail);
        }

        // ---- the three actions -------------------------------------------
        void RunChecks(bool thenStart)
        {
            if (busy) return;
            SetBusy(true);
            Ui(delegate { checks.Items.Clear(); });
            SetStatus("Running pre-checks...", CAmber);
            var t = new Thread(delegate ()
            {
                List<CheckResult> results;
                try { results = PreChecks.Run(deployment, true, AddCheck, Log); }
                catch (Exception ex)
                {
                    Log("Pre-checks crashed: " + ex);
                    SetStatus("Pre-checks could not run", CRed);
                    SetBusy(false);
                    return;
                }
                int fails = results.Count(r => r.Level == Level.Fail);
                int warns = results.Count(r => r.Level == Level.Warn);
                Log("Pre-checks: " + results.Count(r => r.Level == Level.Pass) + " passed, " + warns + " warnings, " + fails + " failed.");
                if (fails > 0)
                {
                    SetStatus(fails + (fails == 1 ? " check failed - not starting" : " checks failed - not starting"), CRed);
                    Log("Fix the FAIL rows above, then press Run checks. Each names its step in docs\\operations\\LAPTOP-HOSTING.md.");
                    SetBusy(false);
                    return;
                }
                if (!thenStart)
                {
                    SetStatus(warns > 0 ? "Ready to start (" + warns + " warnings)" : "Ready to start", warns > 0 ? CAmber : CGreen);
                    SetBusy(false);
                    Heartbeat();
                    return;
                }
                DoStart();
            });
            t.IsBackground = true;
            t.Start();
        }

        void RunStart()
        {
            if (busy) return;
            RunChecks(true);
        }

        void DoStart()
        {
            bool ok;
            try
            {
                ok = Operations.Start(deployment, Log, delegate (string s) { SetStatus(s, CAmber); });
            }
            catch (Exception ex)
            {
                Log("Start crashed: " + ex);
                ok = false;
            }
            if (ok)
            {
                SetStatus("LIVE - " + deployment.PublicOrigin().Replace("https://", ""), CGreen);
                Log("karobakbak is live. This window can be closed; the site keeps running.");
                Ui(delegate { heartbeat.Start(); });
            }
            else
            {
                SetStatus("Start did not complete - read the log", CRed);
            }
            RefreshPersonas();
            SetBusy(false);
        }

        void RunStop()
        {
            if (busy) return;
            DialogResult answer = MessageBox.Show(this,
                "This takes " + deployment.PublicOrigin().Replace("https://", "") + " offline.\n\n" +
                "Anybody in a conversation is disconnected. Data is kept.\n\nStop the site?",
                "Stop karobakbak", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            SetBusy(true);
            heartbeat.Stop();
            SetStatus("Stopping...", CAmber);
            var t = new Thread(delegate ()
            {
                bool ok = false;
                try { ok = Operations.Stop(deployment, Log); }
                catch (Exception ex) { Log("Stop crashed: " + ex); }
                SetStatus(ok ? "Stopped - the site is offline" : "Stop did not complete - read the log", ok ? CMuted : CRed);
                SetBusy(false);
            });
            t.IsBackground = true;
            t.Start();
        }

        // ---- personas ----------------------------------------------------
        void RefreshPersonas()
        {
            if (deployment.Root == null || deployment.Docker == null || deployment.Env.Count == 0) return;
            PersonaStatus st;
            try { st = Personas.Status(deployment); } catch { return; }
            personas = st;
            Ui(delegate
            {
                personaLine.Text = st.Describe();
                personaLine.ForeColor = st.IsOn ? CGreen : st.SwitchOn ? CAmber : CMuted;
                personaBtn.Text = st.IsOn ? "Personas: ON" : "Personas: OFF";
                personaBtn.BackColor = st.IsOn ? CGreen : CPanel;
                personaBtn.ForeColor = st.IsOn ? CInk : CText;
                personaBtn.FlatAppearance.BorderColor = st.IsOn ? CGreen : CMuted;
            });
        }

        void TogglePersonas()
        {
            if (busy) return;
            if (deployment.Env.Count == 0)
            {
                MessageBox.Show(this, "Run the checks first - the configuration has not been read yet.", "Personas");
                return;
            }
            bool turningOn = personas == null || !personas.IsOn;
            string limit = personas != null && personas.Limit > 0
                ? PersonaStatus.Dollars(personas.Limit)
                : "PERSONA_MONTHLY_LIMIT_MICRO_CENTS";
            string question = turningOn
                ? "Turn AI personas ON?\n\nWhen somebody waits alone, a persona may join them. Its replies are paid to " +
                  (deployment.Get("PERSONA_PROVIDER") ?? "the model provider") + ", capped at " + limit +
                  " a month.\n\nThey only join during their active hours."
                : "Turn AI personas OFF?\n\nConversations already running finish; no new ones start.";
            if (MessageBox.Show(this, question, "Personas", MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                                MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;

            SetBusy(true);
            SetStatus(turningOn ? "Turning personas on..." : "Turning personas off...", CAmber);
            var t = new Thread(delegate ()
            {
                bool ok = false;
                try { ok = turningOn ? Personas.TurnOn(deployment, Log) : Personas.TurnOff(deployment, Log); }
                catch (Exception ex) { Log("Personas crashed: " + ex); }
                if (!ok) Log("Personas: " + (turningOn ? "not turned on" : "not turned off") + " - read the lines above.");
                RefreshPersonas();
                SetBusy(false);
                Heartbeat();
            });
            t.IsBackground = true;
            t.Start();
        }

        // Every 30 s while the window is open: is the public site answering?
        void Heartbeat()
        {
            if (busy) return;
            var t = new Thread(delegate ()
            {
                int code = Operations.HttpStatus(deployment.PublicOrigin() + "/ready", true);
                RefreshPersonas();
                if (busy) return;
                if (code == 200) SetStatus("LIVE - " + deployment.PublicOrigin().Replace("https://", ""), CGreen);
                else SetStatus("Not answering publicly (" + (code == 0 ? "no response" : code.ToString()) + ")", CRed);
            });
            t.IsBackground = true;
            t.Start();
            Ui(delegate { if (!heartbeat.Enabled) heartbeat.Start(); });
        }
    }

    static class Program
    {
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [DllImport("kernel32.dll")]
        static extern bool AttachConsole(int pid);

        [STAThread]
        static int Main(string[] args)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var deployment = new Deployment(Deployment.FindRoot());

            if (args.Contains("--check"))
            {
                // A windowed exe has no console; borrow the parent's so the
                // output is visible when run from a terminal.
                AttachConsole(-1);
                var results = PreChecks.Run(deployment, false, null, null);
                foreach (var r in results)
                {
                    Console.WriteLine("[" + r.Level.ToString().ToUpperInvariant().PadRight(4) + "] " + r.Name.PadRight(26) + r.Detail);
                }
                int fails = results.Count(r => r.Level == Level.Fail);
                Console.WriteLine(fails == 0 ? "pre-checks: no failures" : "pre-checks: " + fails + " failed");
                return fails == 0 ? 0 : 1;
            }

            bool created;
            using (var mutex = new Mutex(true, "Local\\karobakbak-live-launcher", out created))
            {
                if (!created)
                {
                    MessageBox.Show("karobakbak live is already open.", "karobakbak live",
                                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }
                try { SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(deployment, !args.Contains("--no-start")));
            }
            return 0;
        }
    }
}
