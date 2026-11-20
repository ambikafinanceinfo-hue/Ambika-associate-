# AMBIKA ASSOCIATE CRM — Google Play Store & Direct APK Release Guide

## 1. Required Google Play Console URLs (Already Live in Your CRM Server)
Paste your live domain before each path when submitting in **Google Play Console → App Content**:
- **Privacy Policy URL**: `https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app/privacy-policy`
- **Terms & Conditions URL**: `https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app/terms-and-conditions`
- **Account / Data Deletion URL**: `https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app/account-deletion`

## 2. Generate Your Play Store Upload Keystore (One-Time)
```bash
keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ambika-upload
```
Create `android-app/keystore.properties` (never commit to Git):
```properties
storeFile=upload-keystore.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=ambika-upload
keyPassword=YOUR_KEY_PASSWORD
```

## 3. Build Signed APK (Direct Mobile Install) & AAB (Google Play Store)
### Option A — Android Studio (Local PC/Mac)
1. Open the `android-app` folder in **Android Studio Koala+**.
2. To build a direct **APK**: `Build → Build Bundle(s) / APK(s) → Build APK(s)` (or `Generate Signed Bundle / APK → APK`).
3. To build a **Google Play `.aab`**: `Build → Generate Signed Bundle / APK → Android App Bundle`.

### Option B — Free Cloud Build via GitHub Actions (No Local Android Studio Needed)
1. Push the `android-app` folder to a GitHub repository (workflow `.github/workflows/build-android.yml` is already included).
2. Add repository secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`).
3. Download `ambika-associate-crm-android-builds` from the **Actions** tab — it contains both `.apk` and `.aab`!

## 4. Upload `.apk` to CRM Admin Settings for 1-Tap Staff Downloads
1. Log in as **Super Admin** in CRM → **Settings → Rules & Branding**.
2. Upload `app-release.apk` under **Upload Signed Android APK**.
3. Anyone tapping **Download APK** on phone/QR modal immediately downloads the signed `.apk`.

## 5. Google Play Console Data Safety Declarations
- **App Type**: Organization / Business Operations (`Finance / Business`)
- **Account Creation / Login**: Employees & Referral Partners authenticated with Admin-issued credentials (provide a demo test account in **App Access** for Play reviewers).
- **Location**: Collected **only in foreground** during explicit Field Officer Bike Run / Visit check-in (`ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`). No background location tracking.
- **Photos / Camera**: Optional KYC document & selfie capture (`CAMERA`).
- **Audio**: Optional follow-up call audio notes (`RECORD_AUDIO`), auto-deleted after 7 days.
- **Encryption**: All network traffic enforced over HTTPS/TLS (`cleartextTrafficPermitted="false"`); PII encrypted at rest on server.
