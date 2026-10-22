package com.razencdev.clipboard_sharings

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
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

@InvokeArg
class SaveImageArgs {
  lateinit var fileName: String
  lateinit var dataBase64: String
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
}
