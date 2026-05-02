# Expo (Mobile)

WebView wrap `https://9remote.cc`. Bridge native ↔ web cho push + version cache.

## Bridge

### Web → Native (postMessage)

| `type` | Mô tả |
|---|---|
| `REQUEST_PUSH_TOKEN` | Web yêu cầu push token, native trả qua `injectJavaScript` |

### Native → Web (`webViewRef.injectJavaScript`)

| Code | Khi nào |
|---|---|
| `window.MOBILE_APP=true` | onLoad |
| `window.MOBILE_APP_TYPE="expo"` | onLoad |
| `window.DEVICE_INFO={platform, version, userAgent}` | onLoad |
| `window.handleExpoPushToken(${tokenJson})` | sau register hoặc nhận `REQUEST_PUSH_TOKEN` |

User-Agent: `"9Remote-Mobile/0.1.7"`.

## Push notification

```js
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert:true, shouldPlaySound:true, shouldSetBadge:true })
})

registerForPushNotificationsAsync():
  if (!Device.isDevice) return null
  status = getPermissionsAsync() || requestPermissionsAsync()
  if (status !== "granted") return null
  return getExpoPushTokenAsync({ projectId: "9remote-app" })

// onMount → register → pushTokenRef.current = token
// Web load → inject window.handleExpoPushToken(token)
// Web emit REQUEST_PUSH_TOKEN → inject lại

addNotificationResponseReceivedListener(() => webViewRef.reload())
```

## Version cache invalidation

```js
VERSION_CHECK_INTERVAL = 5*60*1000  // 5 min
CACHE_KEY = "@9remote:cached_version"

setInterval(async () => {
  if (!isOnline) return
  const remote = await fetch("https://9remote.cc/api/version").json()
  const cached = JSON.parse(await AsyncStorage.getItem(CACHE_KEY) || "null")
  const needsUpdate =
    remote.forceUpdate ||
    !cached ||
    cached.version   !== remote.version ||
    cached.buildTime !== remote.buildTime
  if (needsUpdate) {
    webViewRef.clearCache(true)
    webViewRef.reload()
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({...remote, updatedAt: Date.now()}))
  }
}, VERSION_CHECK_INTERVAL)
```

## Hardware back (Android)

```js
if (Platform.OS === "android") {
  BackHandler.addEventListener("hardwareBackPress", () => {
    if (canGoBack) { webViewRef.goBack(); return true }
    return false
  })
}
// canGoBack từ onNavigationStateChange
```

## Device info inject

```js
onLoad → injectJavaScript(`
  window.MOBILE_APP = true;
  window.MOBILE_APP_TYPE = "expo";
  window.DEVICE_INFO = ${JSON.stringify({ platform: Platform.OS, version: "0.1.7", userAgent: "9Remote-Mobile/0.1.7" })};
  true;
`)
```

Web check `window.MOBILE_APP` để hiện UI mobile.

## WebView config

```js
{
  source: { uri: "https://9remote.cc" },
  userAgent: "9Remote-Mobile/0.1.7",
  cacheMode: "LOAD_CACHE_ELSE_NETWORK",
  mixedContentMode: "always",
  thirdPartyCookiesEnabled: true,
  sharedCookiesEnabled: true,
  pullToRefreshEnabled: CONFIG.pullToRefresh,
  allowsInlineMediaPlayback: true,
  allowsBackForwardNavigationGestures: true
}
```

## Files

```
expo/
  App.js                          entry, providers
  components/WebViewContainer.js  ~200 LOC chính
  hooks/                          push, online, version
  package.json
  app.json                        Expo config + projectId
```

## Mở rộng

- **Bridge message mới**: thêm `case` trong `onMessage` switch + handler.
- **Inject feature**: `webViewRef.injectJavaScript(...)`. Nhớ `true;` cuối.
- **Native API mới**: Expo SDK module → import → wrap thành hook.
- **Deep link** (chưa có): `expo-linking` + `Linking.addEventListener`.
