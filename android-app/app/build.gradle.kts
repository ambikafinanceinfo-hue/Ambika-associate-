import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

val envKeystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
val envKeystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val envKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
val envKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")

val hasReleaseSigning = keystorePropertiesFile.exists() ||
    (!envKeystorePath.isNullOrBlank() && !envKeystorePassword.isNullOrBlank() && !envKeyAlias.isNullOrBlank())

android {
    namespace = "in.ambikaassociate.crm"
    compileSdk = 35

    defaultConfig {
        applicationId = "in.ambikaassociate.crm"
        minSdk = 24
        targetSdk = 35
        versionCode = 10003
        versionName = "2.2.0"

        // Automatically patched to your live HTTPS server URL by /api/public/android-app-kit
        buildConfigField(
            "String",
            "CRM_BASE_URL",
            "\"https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app\""
        )
        buildConfigField(
            "String",
            "CRM_DEV_URL",
            "\"https://ais-dev-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app\""
        )
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                if (keystorePropertiesFile.exists()) {
                    storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                    storePassword = keystoreProperties.getProperty("storePassword")
                    keyAlias = keystoreProperties.getProperty("keyAlias")
                    keyPassword = keystoreProperties.getProperty("keyPassword")
                } else if (!envKeystorePath.isNullOrBlank()) {
                    storeFile = file(envKeystorePath)
                    storePassword = envKeystorePassword
                    keyAlias = envKeyAlias
                    keyPassword = envKeyPassword ?: envKeystorePassword
                }
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
