package com.philgewhite.dashboardcapture;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.util.TypedValue;
import android.view.WindowInsets;
import android.webkit.MimeTypeMap;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Receives files shared from any app, uploads them to the dashboard's own
 * files.php, and opens the dashboard with a pointer to them.
 *
 * Exists because on this phone Chrome's WebAPK share target delivers a
 * multipart body with every file part missing (link shares still work).
 * Native apps read a shared content:// URI themselves, which does work --
 * so this app does exactly that, and nothing more. What happens to the
 * files once they arrive is entirely the dashboard's own Capture Inbox
 * logic (sharetarget.js takeRelayShare), so behaviour can keep evolving
 * in the web app without rebuilding this one.
 *
 * Hand-off: each file is uploaded as-is, then a small JSON manifest
 * ({v, title, text, files:[{id,name,type,size}]}) is uploaded too, and
 * the dashboard opens at ?relay=<manifest id>. Only that one opaque id
 * travels in the URL, so filenames and shared text never reach a server log.
 */
public class MainActivity extends Activity {
	private static final String PREFS = "relay";
	private static final String DEFAULT_DASHBOARD_URL = "https://philgewhite-maker.github.io/dashboard/index.html";
	// files.php's own limit -- checked here too so an oversized file fails
	// fast, before a long upload the server would only reject.
	private static final long MAX_BYTES = 25L * 1024 * 1024;
	// A well-formed id that never exists: a 404 for it means the secret was
	// accepted, a 401 means it wasn't.
	private static final String PROBE_ID = "00000000000000000000000000000000";

	private final Handler ui = new Handler(Looper.getMainLooper());
	private LinearLayout content;
	private TextView progressText;

	private Intent pendingShare;
	private final List<Item> items = new ArrayList<>();
	private String shareTitle = "";
	private String shareText = "";
	private String sharedType;
	private String manifestError;
	private boolean working;

	private static final class Item {
		Uri uri;
		File cached;
		String name;
		String type;
		JSONObject meta;
		String error;
		boolean skipped;
	}

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		ScrollView scroll = new ScrollView(this);
		scroll.setFillViewport(true);
		content = new LinearLayout(this);
		content.setOrientation(LinearLayout.VERTICAL);
		scroll.addView(content);
		int pad = dp(20);
		// targetSdk 35 draws edge-to-edge, so keep content clear of the bars
		// and the keyboard ourselves.
		scroll.setOnApplyWindowInsetsListener((v, insets) -> {
			Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
			content.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, pad + bars.bottom);
			return WindowInsets.CONSUMED;
		});
		setContentView(scroll);
		handle(getIntent());
	}

	@Override
	protected void onNewIntent(Intent intent) {
		super.onNewIntent(intent);
		setIntent(intent);
		if (!working) handle(intent);
	}

	private void handle(Intent intent) {
		String action = intent == null ? null : intent.getAction();
		if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
			if (isConfigured()) {
				startShare(intent);
			} else {
				pendingShare = intent;
				showSetup(null, null, null, "Set this app up once first: in the dashboard, Settings → Live sync → “Set up Dashboard Capture”. What you just shared goes through as soon as you save.");
			}
		} else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null && "setup".equals(intent.getData().getHost())) {
			Uri d = intent.getData();
			showSetup(d.getQueryParameter("sync"), d.getQueryParameter("secret"), d.getQueryParameter("dashboard"),
				"Check the server below is yours, then tap Save.");
		} else {
			showSetup(null, null, null, isConfigured()
				? "Ready. Share images or files to “Dashboard Capture” from any app."
				: "Not set up yet. In the dashboard: Settings → Live sync → “Set up Dashboard Capture” — or fill these in by hand.");
		}
	}

	// ---- Setup ---------------------------------------------------------

	private void showSetup(String syncIn, String secretIn, String dashIn, String message) {
		SharedPreferences p = prefs();
		content.removeAllViews();
		addTitle("Dashboard Capture");
		addText(message);
		if (syncIn != null) {
			String host = Uri.parse(syncIn).getHost();
			TextView server = addText("Server: " + (host == null ? "(not a valid URL)" : host));
			server.setTypeface(Typeface.DEFAULT_BOLD);
		}
		EditText sync = addField("Sync URL (the one ending in sync.php)", syncIn != null ? syncIn : p.getString("syncUrl", ""),
			InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
		EditText secret = addField("Sync secret", secretIn != null ? secretIn : p.getString("secret", ""),
			InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
		EditText dash = addField("Dashboard URL", dashIn != null ? dashIn : p.getString("dashboardUrl", DEFAULT_DASHBOARD_URL),
			InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
		TextView status = addText("");
		Button save = addButton("Save & test");
		save.setOnClickListener(v -> {
			String s = sync.getText().toString().trim();
			String sec = secret.getText().toString().trim();
			String d = dash.getText().toString().trim();
			String problem = validate(s, sec, d);
			if (problem != null) {
				status.setText(problem);
				return;
			}
			save.setEnabled(false);
			status.setText("Testing…");
			new Thread(() -> {
				String result = probe(filesEndpoint(s), sec);
				ui.post(() -> {
					save.setEnabled(true);
					if (result != null) {
						status.setText(result);
						return;
					}
					p.edit().putString("syncUrl", s).putString("secret", sec).putString("dashboardUrl", d).apply();
					if (pendingShare != null) {
						Intent share = pendingShare;
						pendingShare = null;
						startShare(share);
					} else {
						status.setText("Saved and connected. Share images or files to “Dashboard Capture” from any app.");
					}
				});
			}).start();
		});
	}

	private static String validate(String sync, String secret, String dash) {
		if (!sync.startsWith("https://")) return "The sync URL needs to start with https://";
		if (filesEndpoint(sync).equals(sync)) return "The sync URL should end in sync.php";
		if (secret.isEmpty()) return "Enter the sync secret";
		if (!dash.startsWith("https://")) return "The dashboard URL needs to start with https://";
		return null;
	}

	// Same derivation as the dashboard's own files.js: files.php sits next
	// to sync.php.
	private static String filesEndpoint(String syncUrl) {
		return syncUrl.replaceFirst("sync\\.php(?=$|\\?)", "files.php");
	}

	private static String probe(String endpoint, String secret) {
		HttpURLConnection c = null;
		try {
			c = (HttpURLConnection) new URL(endpoint + "?id=" + PROBE_ID).openConnection();
			c.setConnectTimeout(15000);
			c.setReadTimeout(15000);
			c.setRequestProperty("X-Sync-Secret", secret);
			int code = c.getResponseCode();
			if (code == 404) return null;
			if (code == 401) return "The server rejected that secret.";
			return "Unexpected reply from the server (HTTP " + code + ") — is that the right URL?";
		} catch (Exception e) {
			return "Couldn't reach the server: " + describe(e);
		} finally {
			if (c != null) c.disconnect();
		}
	}

	// ---- Share ---------------------------------------------------------

	private void startShare(Intent intent) {
		items.clear();
		manifestError = null;
		shareTitle = firstNonEmpty(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getStringExtra(Intent.EXTRA_TITLE));
		CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
		shareText = text == null ? "" : text.toString();
		sharedType = intent.getType();
		for (Uri u : sharedUris(intent)) {
			Item it = new Item();
			it.uri = u;
			items.add(it);
		}
		if (items.isEmpty()) {
			showMessage("Nothing to capture", "This app only takes files. Share links and text to “Dashboard” instead.");
			return;
		}
		run();
	}

	@SuppressWarnings("deprecation")
	private static List<Uri> sharedUris(Intent intent) {
		Set<Uri> out = new LinkedHashSet<>();
		// The typed getters are the modern API, but they're buggy on Android
		// 13 itself, so only trust them from 14 up.
		if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
			ArrayList<Uri> list;
			if (Build.VERSION.SDK_INT >= 34) list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
			else list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
			if (list != null) {
				for (Uri u : list) if (u != null) out.add(u);
			}
		} else {
			Uri u;
			if (Build.VERSION.SDK_INT >= 34) u = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
			else u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
			if (u != null) out.add(u);
		}
		// Some apps only put the files in ClipData.
		ClipData clip = intent.getClipData();
		if (out.isEmpty() && clip != null) {
			for (int i = 0; i < clip.getItemCount(); i++) {
				Uri u = clip.getItemAt(i).getUri();
				if (u != null) out.add(u);
			}
		}
		return new ArrayList<>(out);
	}

	private void run() {
		working = true;
		showProgress("Reading…");
		new Thread(this::pipeline).start();
	}

	// Idempotent, so Retry just calls it again: anything already copied or
	// uploaded is skipped.
	private void pipeline() {
		SharedPreferences p = prefs();
		String endpoint = filesEndpoint(p.getString("syncUrl", ""));
		String secret = p.getString("secret", "");
		int total = items.size();

		// Copy everything locally first, while the share's read grant is
		// fresh, so a slow upload can never outlive it.
		for (int i = 0; i < total; i++) {
			Item it = items.get(i);
			if (it.skipped || it.cached != null) continue;
			try {
				copyToCache(it, i);
				it.error = null;
			} catch (Exception e) {
				it.error = describe(e);
			}
		}

		for (int i = 0; i < total; i++) {
			Item it = items.get(i);
			if (it.skipped || it.meta != null || it.cached == null) continue;
			updateProgress("Uploading " + (i + 1) + " of " + total + " — " + it.name);
			try {
				it.meta = upload(endpoint, secret, it.cached, it.name, it.type);
				it.error = null;
			} catch (Exception e) {
				it.error = describe(e);
			}
		}

		List<Item> failed = new ArrayList<>();
		List<Item> done = new ArrayList<>();
		for (Item it : items) {
			if (it.skipped) continue;
			if (it.meta != null) done.add(it);
			else failed.add(it);
		}
		if (!failed.isEmpty()) {
			ui.post(() -> showFailures(failed));
			return;
		}
		if (done.isEmpty()) {
			ui.post(() -> showMessage("Nothing sent", "Every file was skipped."));
			return;
		}

		updateProgress("Handing over to the dashboard…");
		try {
			JSONObject manifest = new JSONObject();
			manifest.put("v", 1);
			manifest.put("title", shareTitle);
			manifest.put("text", shareText);
			JSONArray files = new JSONArray();
			for (Item it : done) files.put(it.meta);
			manifest.put("files", files);
			File mf = new File(getCacheDir(), "manifest.json");
			try (OutputStream out = new FileOutputStream(mf)) {
				out.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
			}
			String manifestId = upload(endpoint, secret, mf, "dashboard-capture.json", "application/json").getString("id");
			manifestError = null;
			ui.post(() -> openDashboard(manifestId));
		} catch (Exception e) {
			manifestError = describe(e);
			ui.post(() -> showFailures(new ArrayList<>()));
		}
	}

	private void copyToCache(Item it, int index) throws IOException {
		ContentResolver cr = getContentResolver();
		String name = null;
		long size = -1;
		try (Cursor c = cr.query(it.uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
			if (c != null && c.moveToFirst()) {
				int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
				int si = c.getColumnIndex(OpenableColumns.SIZE);
				if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
				if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
			}
		} catch (RuntimeException e) {
			// Metadata is a nicety; the bytes are what matter.
		}
		if (name == null || name.isEmpty()) name = it.uri.getLastPathSegment();
		if (name == null || name.isEmpty()) name = "shared-" + (index + 1);
		it.name = name;
		it.type = mimeFor(cr.getType(it.uri), name);
		if (size > MAX_BYTES) throw new IOException("too large (" + (size / 1048576) + " MB; the limit is 25 MB)");

		File out = new File(getCacheDir(), "share-" + index + "-" + System.nanoTime());
		long copied = 0;
		try (InputStream in = cr.openInputStream(it.uri); OutputStream os = new FileOutputStream(out)) {
			if (in == null) throw new IOException("couldn't open it");
			byte[] buf = new byte[64 * 1024];
			int n;
			while ((n = in.read(buf)) > 0) {
				os.write(buf, 0, n);
				copied += n;
				if (copied > MAX_BYTES) throw new IOException("too large (the limit is 25 MB)");
			}
		} catch (IOException | RuntimeException e) {
			out.delete();
			throw e;
		}
		if (copied == 0) {
			out.delete();
			throw new IOException("the file was empty");
		}
		it.cached = out;
	}

	// The provider's own type, unless it's missing or the useless generic
	// one -- then the extension, then whatever the share intent declared.
	private String mimeFor(String fromProvider, String name) {
		if (fromProvider != null && !fromProvider.isEmpty() && !"application/octet-stream".equals(fromProvider)) return fromProvider;
		int dot = name.lastIndexOf('.');
		if (dot >= 0) {
			String guess = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
			if (guess != null) return guess;
		}
		if (sharedType != null && !sharedType.contains("*")) return sharedType;
		return "application/octet-stream";
	}

	// Same request the dashboard's own uploadAttachment makes: the raw bytes
	// as the body, metadata in headers. Fixed-length rather than chunked,
	// because files.php reads php://input, which not every PHP setup fills
	// from a chunked body.
	private static JSONObject upload(String endpoint, String secret, File f, String name, String type) throws IOException, JSONException {
		HttpURLConnection c = (HttpURLConnection) new URL(endpoint + "?action=upload").openConnection();
		try {
			c.setConnectTimeout(20000);
			c.setReadTimeout(120000);
			c.setRequestMethod("POST");
			c.setDoOutput(true);
			c.setFixedLengthStreamingMode(f.length());
			c.setRequestProperty("X-Sync-Secret", secret);
			// Header values must be Latin-1, so the name travels URL-encoded
			// (files.php rawurldecodes it).
			c.setRequestProperty("X-File-Name", URLEncoder.encode(name, "UTF-8").replace("+", "%20"));
			c.setRequestProperty("X-File-Type", type);
			c.setRequestProperty("Content-Type", "application/octet-stream");
			try (InputStream in = new FileInputStream(f); OutputStream out = c.getOutputStream()) {
				byte[] buf = new byte[64 * 1024];
				int n;
				while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
			}
			int code = c.getResponseCode();
			String body = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
			if (code == 401) throw new IOException("the server rejected the secret — open this app and redo setup");
			if (code != 200) throw new IOException(serverError(body, code));
			return new JSONObject(body);
		} finally {
			c.disconnect();
		}
	}

	private static void deleteRemote(String endpoint, String secret, String id) {
		HttpURLConnection c = null;
		try {
			c = (HttpURLConnection) new URL(endpoint + "?action=delete&id=" + id).openConnection();
			c.setConnectTimeout(15000);
			c.setReadTimeout(15000);
			c.setRequestMethod("POST");
			c.setRequestProperty("X-Sync-Secret", secret);
			c.getResponseCode();
		} catch (Exception e) {
			// Best effort: a stray file on the server is harmless.
		} finally {
			if (c != null) c.disconnect();
		}
	}

	private void openDashboard(String manifestId) {
		working = false;
		cleanupCache();
		String base = prefs().getString("dashboardUrl", DEFAULT_DASHBOARD_URL);
		Uri uri = Uri.parse(base).buildUpon().appendQueryParameter("relay", manifestId).build();
		Intent view = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
		// Aim straight at the installed Dashboard app (a Chrome WebAPK) if
		// there is one, rather than whatever handles https by default,
		// which would usually be a plain browser tab.
		String pkg = webApkPackage(view);
		if (pkg != null) view.setPackage(pkg);
		try {
			startActivity(view);
		} catch (ActivityNotFoundException e) {
			view.setPackage(null);
			startActivity(view);
		}
		finish();
	}

	private String webApkPackage(Intent view) {
		List<ResolveInfo> handlers = getPackageManager().queryIntentActivities(view, PackageManager.MATCH_ALL);
		for (ResolveInfo r : handlers) {
			String p = r.activityInfo.packageName;
			if (p.startsWith("org.chromium.webapk.")) return p;
		}
		return null;
	}

	private void cleanupCache() {
		File[] files = getCacheDir().listFiles();
		if (files == null) return;
		for (File f : files) {
			String n = f.getName();
			if (n.startsWith("share-") || n.equals("manifest.json")) f.delete();
		}
		for (Item it : items) it.cached = null;
	}

	// ---- Screens -------------------------------------------------------

	private void showProgress(String text) {
		content.removeAllViews();
		addTitle("Sending to Dashboard");
		ProgressBar bar = new ProgressBar(this);
		bar.setIndeterminate(true);
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(40), dp(40));
		lp.topMargin = dp(16);
		content.addView(bar, lp);
		progressText = addText(text);
	}

	private void updateProgress(String text) {
		ui.post(() -> {
			if (progressText != null) progressText.setText(text);
		});
	}

	private void showFailures(List<Item> failed) {
		working = false;
		content.removeAllViews();
		addTitle("Couldn't send everything");
		for (Item it : failed) {
			addText("• " + (it.name != null ? it.name : "A file") + ": " + it.error);
		}
		if (manifestError != null) addText("• Handing over to the dashboard: " + manifestError);
		Button retry = addButton("Retry");
		retry.setOnClickListener(v -> run());
		int ok = 0;
		for (Item it : items) if (it.meta != null) ok++;
		if (ok > 0 && !failed.isEmpty()) {
			Button skip = addButton("Send just the " + ok + " that worked");
			skip.setOnClickListener(v -> {
				for (Item it : failed) it.skipped = true;
				run();
			});
		}
		Button cancel = addButton("Cancel");
		cancel.setOnClickListener(v -> {
			// Don't leave uploads nothing will ever pick up.
			SharedPreferences p = prefs();
			String endpoint = filesEndpoint(p.getString("syncUrl", ""));
			String secret = p.getString("secret", "");
			List<String> uploaded = new ArrayList<>();
			for (Item it : items) if (it.meta != null) uploaded.add(it.meta.optString("id"));
			new Thread(() -> {
				for (String id : uploaded) deleteRemote(endpoint, secret, id);
			}).start();
			cleanupCache();
			finish();
		});
	}

	private void showMessage(String title, String text) {
		working = false;
		content.removeAllViews();
		addTitle(title);
		addText(text);
		Button close = addButton("Close");
		close.setOnClickListener(v -> finish());
	}

	// ---- View helpers --------------------------------------------------

	private void addTitle(String text) {
		TextView t = new TextView(this);
		t.setText(text);
		t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
		t.setTypeface(Typeface.DEFAULT_BOLD);
		content.addView(t);
	}

	private TextView addText(String text) {
		TextView t = new TextView(this);
		t.setText(text);
		t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
		lp.topMargin = dp(12);
		content.addView(t, lp);
		return t;
	}

	private EditText addField(String label, String value, int inputType) {
		TextView l = addText(label);
		l.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
		EditText e = new EditText(this);
		// No setSingleLine(): it swaps out the password transformation and
		// would show the secret in clear. A text input type without the
		// multi-line flag is already single-line.
		e.setInputType(inputType);
		e.setText(value);
		content.addView(e, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
		return e;
	}

	private Button addButton(String text) {
		Button b = new Button(this);
		b.setText(text);
		b.setAllCaps(false);
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
		lp.topMargin = dp(12);
		content.addView(b, lp);
		return b;
	}

	// ---- Small utilities -----------------------------------------------

	private SharedPreferences prefs() {
		return getSharedPreferences(PREFS, MODE_PRIVATE);
	}

	private boolean isConfigured() {
		SharedPreferences p = prefs();
		return !p.getString("syncUrl", "").isEmpty() && !p.getString("secret", "").isEmpty();
	}

	private int dp(int v) {
		return Math.round(v * getResources().getDisplayMetrics().density);
	}

	private static String firstNonEmpty(String a, String b) {
		if (a != null && !a.trim().isEmpty()) return a.trim();
		if (b != null && !b.trim().isEmpty()) return b.trim();
		return "";
	}

	private static String describe(Exception e) {
		if (e instanceof UnknownHostException) return "no connection";
		if (e instanceof SocketTimeoutException) return "the server took too long";
		if (e instanceof SecurityException) return "the sharing app didn't grant access to it";
		String m = e.getMessage();
		return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
	}

	private static String serverError(String body, int code) {
		try {
			String err = new JSONObject(body).optString("error");
			if (!err.isEmpty()) return err;
		} catch (Exception ignored) {
			// Not JSON -- fall through to the status code.
		}
		return "HTTP " + code;
	}

	private static String readAll(InputStream in) throws IOException {
		if (in == null) return "";
		try (InputStream s = in) {
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			byte[] buf = new byte[8192];
			int n;
			while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
			return out.toString("UTF-8");
		}
	}
}
