package com.razencdev.clipboard_sharings

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

@InvokeArg
class SaveImageArgs {
  lateinit var fileName: String
  lateinit var dataBase64: String
}

@InvokeArg
class InstallUpdateArgs {
  lateinit var apkUrl: String
  lateinit var version: String
}

@TauriPlugin(
  permissions = [
    Permission(
      strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE],
      alias = "storage"
    )
  ]
)
class ImageSaverPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private const val MAX_APK_BYTES = 200L * 1024L * 1024L
  }

  @Command
  fun saveImage(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
      requestPermissionForAlias("storage", invoke, "storagePermissionResult")
      return
    }
    persistImage(invoke)
  }

  @PermissionCallback
  fun storagePermissionResult(invoke: Invoke) {
    if (getPermissionState("storage") == PermissionState.GRANTED) {
      persistImage(invoke)
    } else {
      invoke.reject("Storage permission is required to save the image")
    }
  }

  private fun persistImage(invoke: Invoke) {
    val args = invoke.parseArgs(SaveImageArgs::class.java)
    val safeName = args.fileName
      .replace(Regex("[^A-Za-z0-9._-]"), "_")
      .let { if (it.lowercase().endsWith(".png")) it else "$it.png" }

    try {
      val bytes = Base64.decode(args.dataBase64, Base64.DEFAULT)
      if (bytes.isEmpty()) throw IllegalArgumentException("Image data is empty")

      val location = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        saveWithMediaStore(safeName, bytes)
      } else {
        saveLegacy(safeName, bytes)
      }

      val result = JSObject()
      result.put("fileName", safeName)
      result.put("location", location)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject("Unable to save image: ${error.message ?: "unknown error"}", error)
    }
  }

  private fun saveWithMediaStore(fileName: String, bytes: ByteArray): String {
    val resolver = activity.contentResolver
    val relativeDirectory = "${Environment.DIRECTORY_PICTURES}/Clipvyn"
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
      put(MediaStore.Images.Media.MIME_TYPE, "image/png")
      put(MediaStore.Images.Media.RELATIVE_PATH, relativeDirectory)
      put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("Android could not create the image file")
    try {
      resolver.openOutputStream(uri, "w")?.use { it.write(bytes) }
        ?: throw IllegalStateException("Android could not open the image file")
      values.clear()
      values.put(MediaStore.Images.Media.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
    return "$relativeDirectory/$fileName"
  }

  @Suppress("DEPRECATION")
  private fun saveLegacy(fileName: String, bytes: ByteArray): String {
    val directory = File(
      Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
      "Clipvyn"
    )
    if (!directory.exists() && !directory.mkdirs()) {
      throw IllegalStateException("Android could not create the Clipvyn picture folder")
    }
    val image = File(directory, fileName)
    FileOutputStream(image).use { it.write(bytes) }
    MediaScannerConnection.scanFile(activity, arrayOf(image.absolutePath), arrayOf("image/png"), null)
    return "${Environment.DIRECTORY_PICTURES}/Clipvyn/$fileName"
  }

  @Command
  fun installUpdate(invoke: Invoke) {
    val args = invoke.parseArgs(InstallUpdateArgs::class.java)
    val source = runCatching { URL(args.apkUrl) }.getOrNull()
    if (source == null || source.protocol != "https") {
      invoke.reject("The update download URL is invalid")
      return
    }
    if (!args.version.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+"))) {
      invoke.reject("The update version is invalid")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      val settingsIntent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${activity.packageName}")
      )
      activity.startActivity(settingsIntent)
      invoke.reject("Allow Clipvyn to install unknown apps, then return and tap Download & install again.")
      return
    }

    Thread {
      val updateDirectory = File(activity.cacheDir, "updates").apply { mkdirs() }
      val partial = File(updateDirectory, "Clipvyn-${args.version}.apk.part")
      try {
        val apk = File(updateDirectory, "Clipvyn-${args.version}.apk")
        partial.delete()
        apk.delete()
        downloadApk(source, partial)
        verifyApk(partial)
        if (!partial.renameTo(apk)) throw IllegalStateException("Unable to prepare the downloaded update")

        activity.runOnUiThread {
          try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
            val installIntent = Intent(Intent.ACTION_VIEW).apply {
              setDataAndType(uri, "application/vnd.android.package-archive")
              addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(installIntent)
            val result = JSObject()
            result.put("version", args.version)
            invoke.resolve(result)
          } catch (error: Exception) {
            apk.delete()
            invoke.reject("Unable to open the Android installer: ${error.message ?: "unknown error"}", error)
          }
        }
      } catch (error: Exception) {
        partial.delete()
        invoke.reject("Unable to download the update: ${error.message ?: "unknown error"}", error)
      }
    }.start()
  }

  private fun downloadApk(source: URL, destination: File) {
    val connection = source.openConnection() as HttpURLConnection
    connection.connectTimeout = 15_000
    connection.readTimeout = 30_000
    connection.instanceFollowRedirects = true
    connection.setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream")
    connection.setRequestProperty("User-Agent", "Clipvyn-Android-Updater")
    try {
      val status = connection.responseCode
      if (status !in 200..299) throw IllegalStateException("Download server returned $status")
      val declaredLength = connection.contentLengthLong
      if (declaredLength > MAX_APK_BYTES) throw IllegalStateException("Update exceeds the 200 MiB limit")
      connection.inputStream.use { input ->
        FileOutputStream(destination).use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > MAX_APK_BYTES) throw IllegalStateException("Update exceeds the 200 MiB limit")
            output.write(buffer, 0, count)
          }
        }
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun verifyApk(file: File) {
    if (file.length() < 1_024) throw IllegalStateException("Downloaded update is empty")
    file.inputStream().use { input ->
      if (input.read() != 0x50 || input.read() != 0x4b) {
        throw IllegalStateException("Downloaded file is not a valid APK")
      }
    }
    val packageInfo = activity.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
      ?: throw IllegalStateException("Android could not read the downloaded APK")
    if (packageInfo.packageName != activity.packageName) {
      throw IllegalStateException("Downloaded APK belongs to a different application")
    }
  }
}
