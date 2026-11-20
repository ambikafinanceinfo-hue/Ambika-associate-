package `in`.ambikaassociate.crm

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var offlineOverlay: LinearLayout

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var cameraImageUri: Uri? = null
    private var pendingPermissionRequest: PermissionRequest? = null
    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null

    private val baseUrl: String
        get() = BuildConfig.CRM_BASE_URL.trimEnd('/')

    private val prefs by lazy {
        getSharedPreferences("ambika_crm_prefs", Context.MODE_PRIVATE)
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = fileUploadCallback
        fileUploadCallback = null
        if (callback == null) return@registerForActivityResult

        if (result.resultCode == RESULT_OK) {
            val data = result.data
            val results: Array<Uri>? = when {
                data?.clipData != null -> {
                    val count = data.clipData!!.itemCount
                    Array(count) { i -> data.clipData!!.getItemAt(i).uri }
                }
                data?.data != null -> arrayOf(data.data!!)
                cameraImageUri != null -> arrayOf(cameraImageUri!!)
                else -> null
            }
            callback.onReceiveValue(results ?: emptyArray())
        } else {
            callback.onReceiveValue(emptyArray())
        }
        cameraImageUri = null
    }

    private val runtimePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val pendingReq = pendingPermissionRequest
        pendingPermissionRequest = null
        if (pendingReq != null) {
            val grantedResources = mutableListOf<String>()
            if (grants[Manifest.permission.CAMERA] == true) {
                grantedResources.add(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
            }
            if (grants[Manifest.permission.RECORD_AUDIO] == true) {
                grantedResources.add(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
            }
            if (grantedResources.isNotEmpty()) {
                pendingReq.grant(grantedResources.toTypedArray())
            } else {
                pendingReq.deny()
            }
        }

        val geoOrigin = pendingGeoOrigin
        val geoCallback = pendingGeoCallback
        pendingGeoOrigin = null
        pendingGeoCallback = null
        if (geoOrigin != null && geoCallback != null) {
            val fine = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true
            val coarse = grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
            geoCallback.invoke(geoOrigin, fine || coarse, true)
        }
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.evaluateJavascript(
                "window.dispatchEvent(new Event('ambika-app-resume'));",
                null
            )
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0F2744.toInt())
        }

        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                8
            )
            max = 100
            visibility = View.GONE
        }

        offlineOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setPadding(64, 64, 64, 64)
            setBackgroundColor(0xFFF8FAFC.toInt())
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.MATCH_PARENT
            )

            addView(TextView(this@MainActivity).apply {
                text = "AMBIKA ASSOCIATE CRM"
                textSize = 20f
                setTextColor(0xFF0F2744.toInt())
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            addView(TextView(this@MainActivity).apply {
                text = "Unable to reach the CRM server. Please check mobile data / Wi-Fi and try again."
                textSize = 14f
                setTextColor(0xFF475569.toInt())
                setPadding(0, 24, 0, 36)
                gravity = android.view.Gravity.CENTER
            })
            addView(Button(this@MainActivity).apply {
                text = "Retry Connection"
                setBackgroundColor(0xFF15803D.toInt())
                setTextColor(0xFFFFFFFF.toInt())
                setOnClickListener {
                    offlineOverlay.visibility = View.GONE
                    webView.visibility = View.VISIBLE
                    webView.loadUrl(baseUrl)
                }
            })
        }

        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        root.addView(progressBar)
        root.addView(offlineOverlay)
        root.addView(webView)
        setContentView(root)

        configureWebView()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        })

        if (prefs.getBoolean("terms_disclosure_accepted_v2", false)) {
            webView.loadUrl(baseUrl)
        } else {
            showFirstLaunchDisclosureDialog()
        }
    }

    /**
     * Google Play Prominent Disclosure & Terms Acceptance Dialog
     * Presented BEFORE any runtime permission prompt or CRM data collection.
     */
    private fun showFirstLaunchDisclosureDialog() {
        val message = """
            Welcome to AMBIKA ASSOCIATE — Smart Finance Smart Saving CRM.
            Head Office: 1st Floor, Anupam Complex, Pateri Road, Near Reliance Bazar, Satna, MP (485001).

            Authorized Staff & Partner Operations Portal (Not a direct consumer lending app; loans are processed exclusively by RBI-regulated partner Banks/NBFCs).

            Before continuing, please review our Terms & Conditions and Privacy Policy:

            1. Location Data (Foreground Only): Used only while the app is open for Daily Office GPS Attendance (within Satna Office zone) and Field Officer Visit / Bike Run mileage verification. No background location tracking.
            2. Camera & Storage: Used only when you capture PAN/Aadhaar KYC documents or visit selfies.
            3. Microphone: Used only when you tap Record Audio for consented follow-up call notes (auto-deleted after 7 days).
            4. Account & Data Deletion: Request deletion anytime at $baseUrl/account-deletion.
        """.trimIndent()

        AlertDialog.Builder(this)
            .setTitle("Terms, Privacy & Permission Disclosure")
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton("Agree & Continue") { _, _ ->
                prefs.edit().putBoolean("terms_disclosure_accepted_v2", true).apply()
                webView.loadUrl(baseUrl)
            }
            .setNeutralButton("Privacy & Terms") { _, _ ->
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse("$baseUrl/terms-and-conditions"))
                startActivity(intent)
                showFirstLaunchDisclosureDialog()
            }
            .setNegativeButton("Exit") { _, _ ->
                finish()
            }
            .show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            setGeolocationEnabled(true)
            useWideViewPort = true
            loadWithOverviewMode = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString AmbikaCRM-Android/${BuildConfig.VERSION_NAME}"
        }
        // Refresh cached web shell whenever the app binary version changes
        val lastWebVersion = prefs.getString("last_web_cache_version", "")
        if (lastWebVersion != BuildConfig.VERSION_NAME) {
            webView.clearCache(true)
            prefs.edit().putString("last_web_cache_version", BuildConfig.VERSION_NAME).apply()
        }

        webView.setDownloadListener { url, userAgent, contentDisposition, mimetype, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                val fileName = URLUtil.guessFileName(url, contentDisposition, mimetype)
                request.setMimeType(mimetype)
                request.addRequestHeader("User-Agent", userAgent)
                val cookies = CookieManager.getInstance().getCookie(url)
                if (!cookies.isNullOrEmpty()) {
                    request.addRequestHeader("Cookie", cookies)
                }
                request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                )
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this, "Downloading $fileName…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                progressBar.visibility = View.VISIBLE
                offlineOverlay.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                progressBar.visibility = View.GONE
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    progressBar.visibility = View.GONE
                    webView.visibility = View.GONE
                    offlineOverlay.visibility = View.VISIBLE
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val uri = request?.url ?: return false
                val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return false

                // Direct phone dialer (`tel:`), SMS, Email, WhatsApp links open native Android apps
                if (scheme == "tel" || scheme == "mailto" || scheme == "sms" || scheme == "whatsapp") {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                    } catch (_: Exception) {
                        Toast.makeText(
                            this@MainActivity,
                            "No app available to handle this action",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                    return true
                }

                val urlStr = uri.toString()
                if (urlStr.startsWith("https://wa.me/") || urlStr.startsWith("https://api.whatsapp.com/")) {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    return true
                }

                val baseHost = Uri.parse(baseUrl).host
                return if (uri.host != null && uri.host == baseHost) {
                    false // Keep inside Ambika CRM WebView
                } else {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                val needed = mutableListOf<String>()
                for (res in request.resources) {
                    if (res == PermissionRequest.RESOURCE_VIDEO_CAPTURE &&
                        ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                    ) {
                        needed.add(Manifest.permission.CAMERA)
                    }
                    if (res == PermissionRequest.RESOURCE_AUDIO_CAPTURE &&
                        ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
                    ) {
                        needed.add(Manifest.permission.RECORD_AUDIO)
                    }
                }
                if (needed.isEmpty()) {
                    request.grant(request.resources)
                } else {
                    pendingPermissionRequest = request
                    runtimePermissionLauncher.launch(needed.toTypedArray())
                }
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                if (origin == null || callback == null) return
                val fineGranted = ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED
                val coarseGranted = ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED

                if (fineGranted || coarseGranted) {
                    callback.invoke(origin, true, true)
                } else {
                    pendingGeoOrigin = origin
                    pendingGeoCallback = callback
                    runtimePermissionLauncher.launch(
                        arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                        )
                    )
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileUploadCallback?.onReceiveValue(emptyArray())
                fileUploadCallback = filePathCallback

                val acceptTypes = fileChooserParams?.acceptTypes?.joinToString(",") ?: ""
                val includeCamera = acceptTypes.contains("image") || fileChooserParams?.isCaptureEnabled == true

                val chooserIntents = mutableListOf<Intent>()
                if (includeCamera &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                ) {
                    val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                    val photoFile = File.createTempFile("CRM_${timeStamp}_", ".jpg", cacheDir)
                    cameraImageUri = FileProvider.getUriForFile(
                        this@MainActivity,
                        "${BuildConfig.APPLICATION_ID}.fileprovider",
                        photoFile
                    )
                    val captureIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                        putExtra(MediaStore.EXTRA_OUTPUT, cameraImageUri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    }
                    chooserIntents.add(captureIntent)
                }

                val contentIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (acceptTypes.contains("audio")) "audio/*" else "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }

                val chooser = Intent(Intent.ACTION_CHOOSER).apply {
                    putExtra(Intent.EXTRA_INTENT, contentIntent)
                    putExtra(Intent.EXTRA_TITLE, "Select Document or Capture Photo")
                    if (chooserIntents.isNotEmpty()) {
                        putExtra(Intent.EXTRA_INITIAL_INTENTS, chooserIntents.toTypedArray())
                    }
                }
                fileChooserLauncher.launch(chooser)
                return true
            }
        }
    }
}
