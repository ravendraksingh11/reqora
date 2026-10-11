# Reqora

Reqora is a reusable React Native API base URL settings modal and Axios activity monitor. It is an independent package and does not depend on CoachCRM.

## Requirements

- React Native 0.72 or newer
- Axios 1.6 or newer
- `react-native-safe-area-context`
- `lucide-react-native`
- An async key/value storage adapter

## Install

From another local app, use the package folder path:

```sh
npm install reqora
```

Install or retain the peer dependencies listed above in the consuming app. Wrap the app in `SafeAreaProvider` from `react-native-safe-area-context`.

## Setup

Create the Axios instance used by the app, then create one manager instance at module scope. Pass your existing storage implementation, so base URLs persist in the storage system your app already uses. Existing authentication and unauthorized-response behavior can be supplied through callbacks.

```tsx
import axios from "axios";
import { ApiBaseUrlSettings, createApiBaseUrlManager } from "reqora";
import { secureStorage } from "./secureStorage";

export const api = axios.create({ baseURL: "https://api.example.com/api" });

export const apiBaseUrlManager = createApiBaseUrlManager({
  axiosInstance: api,
  storage: secureStorage,
  storageKey: "api_base_url",
  getAuthToken: () => secureStorage.getItem("access_token"),
  onUnauthorized: () => authStore.getState().clearSession(),
});

export function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
      <ApiBaseUrlSettings manager={apiBaseUrlManager} />
    </SafeAreaProvider>
  );
}
```

Mount `ApiBaseUrlSettings` once inside the app root and within `SafeAreaProvider`. The floating launcher will then remain available above app screens. Safe-area insets place it above device system bars, and the modal scrolls when its contents exceed the available height.

## Manager API

- `getBaseUrl()` reads the active URL.
- `saveBaseUrl(url)` validates and persists an HTTP/HTTPS URL, then immediately changes `axiosInstance.defaults.baseURL`.
- `getActivity()` returns recent request/response entries, with timing and sensitive values redacted.
- `subscribeToActivity(listener)` subscribes to activity updates.
- `clearActivity()` removes the in-memory activity history.

The package does not configure an Axios instance for you; pass the same instance your API calls already use. It adds interceptors once when `createApiBaseUrlManager` is called. Do not create the manager repeatedly during component renders.
