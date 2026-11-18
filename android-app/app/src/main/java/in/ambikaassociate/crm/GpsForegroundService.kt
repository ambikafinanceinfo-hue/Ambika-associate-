package `in`.ambikaassociate.crm

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors

class GpsForegroundService : Service() {
    companion object {
        const val ACTION_START = "ACTION_START"
        const val ACTION_STOP = "ACTION_STOP"
        const val EXTRA_TOKEN = "EXTRA_TOKEN"
        const val EXTRA_BIKE_RUN_ID = "EXTRA_BIKE_RUN_ID"
        private const val CHANNEL_ID = "ambika_gps_channel"
        private const val NOTIF_ID = 4001
    }

    private lateinit var fusedClient: FusedLocationProviderClient
    private val httpClient = OkHttpClient()
    private val executor = Executors.newSingleThreadExecutor()
    private var authToken: String = ""
    private var bikeRunId: Long = -1L

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val loc = result.lastLocation ?: return
            if (authToken.isBlank()) return
            executor.execute {
                postLocationPing(loc.latitude, loc.longitude, loc.accuracy.toDouble())
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            fusedClient.removeLocationUpdates(locationCallback)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        authToken = intent?.getStringExtra(EXTRA_TOKEN) ?: ""
        bikeRunId = intent?.getLongExtra(EXTRA_BIKE_RUN_ID, -1L) ?: -1L

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AMBIKA ASSOCIATE Field GPS Active")
            .setContentText("Recording consent-based field visit & bike run coordinates")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .build()

        startForeground(NOTIF_ID, notification)
        startLocationUpdates()
        return START_STICKY
    }

    private fun startLocationUpdates() {
        if (ActivityCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_FINE_LOCATION
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 30_000L)
            .setMinUpdateDistanceMeters(25f)
            .build()
        fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
    }

    private fun postLocationPing(lat: Double, lng: Double, accuracy: Double) {
        val json = JSONObject().apply {
            put("latitude", lat)
            put("longitude", lng)
            put("accuracy", accuracy)
            put("activityType", "TRACKING_PING")
            put("consentConfirmed", true)
        }
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val req = Request.Builder()
            .url("${BuildConfig.CRM_BASE_URL}/api/gps")
            .addHeader("Authorization", "Bearer $authToken")
            .post(json.toString().toRequestBody(mediaType))
            .build()
        runCatching { httpClient.newCall(req).execute().close() }

        if (bikeRunId > 0L) {
            val wpJson = JSONObject().apply {
                put("latitude", lat)
                put("longitude", lng)
            }
            val wpReq = Request.Builder()
                .url("${BuildConfig.CRM_BASE_URL}/api/bike-runs/$bikeRunId/waypoint")
                .addHeader("Authorization", "Bearer $authToken")
                .post(wpJson.toString().toRequestBody(mediaType))
                .build()
            runCatching { httpClient.newCall(wpReq).execute().close() }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Field Officer GPS Tracking",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
