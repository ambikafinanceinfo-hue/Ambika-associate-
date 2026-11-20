# AMBIKA ASSOCIATE CRM — Google Play Store (.aab) & Direct Android APK Release Guide

- **App Name:** Ambika Associate CRM
- **Application / Package ID:** `in.ambikaassociate.crm`
- **Target SDK:** Android 15 (`targetSdk = 35`, `compileSdk = 35`, `minSdk = 24`)
- **Version:** `2.2.0` (`versionCode = 10003`)
- **Registered Office:** 1st Floor, Anupam Complex, Pateri Road, Near Reliance Bazar, Satna, MP (485001)

---

## 1. Required Google Play Console Legal URLs (Live & Verified)
Paste these exact URLs into **Google Play Console → App Content**:
- **Privacy Policy URL:** `https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app/privacy-policy`
- **Terms & Conditions URL:** `https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app/terms-and-conditions`
- **Account / Data Deletion URL:** `https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app/account-deletion`

---

## 2. Generate Your Play Store Upload Keystore (One-Time)
Run once on any Windows/Mac/Linux computer (or Cloud Shell) with Java installed:
```bash
keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ambika-upload
```
Create `android-app/keystore.properties` (keep private — never share publicly):
```properties
storeFile=upload-keystore.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=ambika-upload
keyPassword=YOUR_KEY_PASSWORD
```

---

## 3. Build Signed `.apk` (Direct Mobile Install) & `.aab` (Google Play Store)

### Option A — Free Cloud Build via GitHub Actions (No Android Studio Needed!)
1. Create a **Private** repository on GitHub (e.g., `ambika-associate-crm-android`).
2. Extract `ambika-associate-android-studio-kit.tar.gz` and upload the `android-app` contents (including `.github/workflows/build-android.yml`) to the repository.
3. *(Optional for signed Play Store `.aab`)* In GitHub → **Settings → Secrets and variables → Actions**, add:
   - `ANDROID_KEYSTORE_BASE64` (base64 of `upload-keystore.jks`)
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
4. Open the **Actions** tab → click **Build Play Store AAB & Direct APK** → **Run workflow**.
5. Download the artifact **`ambika-associate-crm-android-builds`** — it includes:
   - `app-debug.apk` (ready to install immediately on any Android phone)
   - `app-release.apk` (signed release APK for direct staff distribution)
   - `app-release.aab` (ready to upload to **Google Play Console → Production / Closed Testing**)

### Option B — Android Studio (Local PC/Mac)
1. Open the extracted `android-app` folder in **Android Studio Koala+**.
2. For Direct Mobile APK: `Build → Generate Signed App Bundle / APK → APK` (or `Build → Build APK(s)`).
3. For Google Play Store: `Build → Generate Signed App Bundle / APK → Android App Bundle (.aab)`.

---

## 4. Upload `.apk` & `.aab` Inside CRM Admin Panel (1-Tap Staff Download)
1. Log in as **Super Admin** (`ADM001`) → **Settings → Rules & Branding**.
2. Upload your built `app-release.apk` (or `app-debug.apk`) under **Upload Signed Android APK**.
3. Once uploaded, every staff member tapping **Download APK** on the Login screen or Mobile Modal downloads the real `.apk` file directly to their Android phone!

---

## 5. Google Play Console Declarations (Important to Avoid Rejection!)
1. **App Category:** `Business` (recommended — avoids consumer Personal Loan lending restrictions).
2. **Financial Features Declaration:**
   - Select **"My app doesn't provide any financial features directly to consumers"** OR declare as **Internal Business / DSA CRM Tool** — explain in reviewer notes that **AMBIKA ASSOCIATE CRM is strictly an internal staff & partner lead-tracking CRM**, NOT a direct consumer lending app, and all loans are sanctioned exclusively by partner RBI-regulated Banks/NBFCs.
3. **App Access (Mandatory for Login-Gated Apps):**
   - Select *"All or some functionality is restricted"* → Add a reviewer demo account (e.g., an active Branch Manager or Field Officer test Employee ID & Password created in Admin Console).
4. **Data Safety Form:**
   - **Personal Info (Name, Email, Phone, User ID):** Collected for App Functionality & Account Management. Encrypted in transit (HTTPS) & at rest. Not sold or shared for ads.
   - **Precise & Approximate Location (Foreground Only):** Collected ONLY while app is open for Daily Office GPS Attendance (Satna Office) and Field Officer Bike Run / Visit verification. **No background location permission (`ACCESS_BACKGROUND_LOCATION` is NOT requested).**
   - **Photos & Audio:** Optional KYC/PAN OCR photos (`CAMERA`) and consented follow-up call audio (`RECORD_AUDIO`, auto-deleted after 7 days).
   - **Deletion Mechanism:** Supported via `https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app/account-deletion`.
5. **Closed Testing (For New Personal Play Developer Accounts):**
   - Google Play requires 12 testers opted-in for 14 days on new personal accounts (use your BM / TL / FO / Back Office team members as testers!). Organization accounts with a D-U-N-S number can publish directly to Production.
