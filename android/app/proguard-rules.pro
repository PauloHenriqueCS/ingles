# ==========================================================================
# Orodim R8/ProGuard keep rules
#
# R8 (minifyEnabled true) shrinks + obfuscates + optimizes. The SDKs below are
# discovered/invoked via reflection, annotations, or JS-bridge name lookup, so
# their symbol names must be preserved or the app breaks at runtime with no
# compile-time error. Keep rules here are deliberately generous: a slightly
# larger APK is an acceptable price for not white-screening a remote-first
# WebView app whose native bridge is name-addressed from JavaScript.
# ==========================================================================

# --- Keep attributes needed for reflection / annotations / generics --------
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault
-keepattributes SourceFile,LineNumberTable

# ==========================================================================
# Capacitor core + plugins
# Capacitor resolves plugins and @PluginMethod handlers by name from the JS
# bridge via reflection. Names must survive obfuscation.
# ==========================================================================
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { *; }
-keep class com.getcapacitor.** { *; }
-keep interface com.getcapacitor.** { *; }
-keepclassmembers class * {
    @com.getcapacitor.annotation.CapacitorPlugin *;
    @com.getcapacitor.PluginMethod public *;
}
-keep class com.getcapacitor.annotation.** { *; }

# Cordova plugins bridged through Capacitor
-keep class org.apache.cordova.** { *; }

# ==========================================================================
# OneSignal (@onesignal/capacitor-plugin) — reflection + service discovery
# ==========================================================================
-keep class com.onesignal.** { *; }
-keep interface com.onesignal.** { *; }
-dontwarn com.onesignal.**

# ==========================================================================
# RevenueCat (@revenuecat/purchases-capacitor) — Kotlin + reflection
# ==========================================================================
-keep class com.revenuecat.** { *; }
-keep interface com.revenuecat.** { *; }
-dontwarn com.revenuecat.**

# ==========================================================================
# @capgo/capacitor-social-login (Google + Apple sign-in bridge)
# ==========================================================================
-keep class ee.forgr.capacitor.social.login.** { *; }
-keep class ee.forgr.capacitor.** { *; }
-dontwarn ee.forgr.capacitor.**

# ==========================================================================
# Google Identity / Sign-In / Credential Manager / Play Services
# Used by native Google sign-in; heavily reflection- and annotation-driven.
# ==========================================================================
-keep class com.google.android.gms.** { *; }
-keep interface com.google.android.gms.** { *; }
-dontwarn com.google.android.gms.**
-keep class com.google.android.libraries.identity.** { *; }
-keep class androidx.credentials.** { *; }
-keep interface androidx.credentials.** { *; }
-dontwarn androidx.credentials.**
-keep class com.google.android.libraries.identity.googleid.** { *; }

# --- Sign in with Apple deep-link handling is pure Capacitor/JS; covered above.

# ==========================================================================
# Kotlin metadata + coroutines (RevenueCat and social-login are Kotlin)
# ==========================================================================
-keep class kotlin.Metadata { *; }
-keepclassmembers class **$WhenMappings { <fields>; }
-keep class kotlin.coroutines.Continuation
-dontwarn kotlin.**
-dontwarn kotlinx.**

# ==========================================================================
# Gson / JSON reflection — plugins (de)serialize models by field name.
# Keep model field names and Gson internals from being stripped/renamed.
# ==========================================================================
-keep class com.google.gson.** { *; }
-dontwarn com.google.gson.**
-keepclassmembers,allowobfuscation class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
# TypeToken generic signatures must survive for Gson reflective types.
-keep class * extends com.google.gson.reflect.TypeToken { *; }

# ==========================================================================
# AndroidX WebKit / WebView JS interfaces — @JavascriptInterface methods are
# called by name from JS and must not be renamed.
# ==========================================================================
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Enum values()/valueOf() are accessed reflectively by several SDKs.
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Parcelable CREATOR fields (Android framework reflection).
-keepclassmembers class * implements android.os.Parcelable {
    public static final android.os.Parcelable$Creator CREATOR;
}
