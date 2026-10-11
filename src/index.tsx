import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import {
  ChevronLeft,
  Settings2,
  Trash2,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const requestStartedAtKey = "__apiBaseUrlStartedAt";
const requestBodyKey = "__apiBaseUrlRequestBody";

export interface ApiBaseUrlStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface ApiActivityEntry {
  id: string;
  method: string;
  url: string;
  status: number | null;
  responseTimeMs: number;
  requestData: string;
  responseData: string;
  createdAt: string;
}

export interface ApiBaseUrlManagerOptions {
  axiosInstance: AxiosInstance;
  storage: ApiBaseUrlStorage;
  storageKey?: string;
  maxActivityEntries?: number;
  getAuthToken?: () => Promise<string | null>;
  onUnauthorized?: (error: AxiosError) => void | Promise<void>;
}

export interface ApiBaseUrlManager {
  getBaseUrl(): Promise<string>;
  saveBaseUrl(baseUrl: string): Promise<string>;
  getActivity(): ApiActivityEntry[];
  subscribeToActivity(listener: () => void): () => void;
  clearActivity(): void;
}

export interface ApiBaseUrlSettingsProps {
  manager: ApiBaseUrlManager;
  launcherBottomOffset?: number;
  launcherRightOffset?: number;
}

type InstrumentedRequestConfig = AxiosRequestConfig & {
  [requestStartedAtKey]?: number;
  [requestBodyKey]?: string;
};

function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|token|secret|authorization|cookie|api[_-]?key/i.test(key)
          ? "[REDACTED]"
          : redactSensitiveData(item),
      ]),
    );
  }
  return value;
}

function formatData(value: unknown) {
  const safeValue = redactSensitiveData(value);
  if (typeof safeValue === "string") return safeValue;
  try {
    return JSON.stringify(safeValue, null, 2) ?? String(safeValue);
  } catch {
    return String(safeValue);
  }
}

function redactUrl(url: string) {
  return url.replace(
    /([?&][^=&]*(?:password|token|secret|authorization|cookie|api[_-]?key)[^=&]*=)[^&]*/gi,
    "$1[REDACTED]",
  );
}

function normalizeBaseUrl(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+(?:\/.*)?$/i.test(normalized)) {
    throw new Error("Enter a valid HTTP or HTTPS URL.");
  }
  return normalized;
}

export function createApiBaseUrlManager({
  axiosInstance,
  storage,
  storageKey = "api_base_url",
  maxActivityEntries = 100,
  getAuthToken,
  onUnauthorized,
}: ApiBaseUrlManagerOptions): ApiBaseUrlManager {
  let activity: ApiActivityEntry[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const addActivity = (entry: ApiActivityEntry) => {
    activity = [entry, ...activity].slice(0, maxActivityEntries);
    notify();
  };

  const baseUrlReady = storage
    .getItem(storageKey)
    .then((baseUrl) => {
      if (baseUrl) axiosInstance.defaults.baseURL = baseUrl;
    })
    .catch(() => undefined);

  const getBaseUrl = async () => {
    await baseUrlReady;
    return axiosInstance.defaults.baseURL ?? "";
  };

  const saveBaseUrl = async (baseUrl: string) => {
    const normalized = normalizeBaseUrl(baseUrl);
    await baseUrlReady;
    await storage.setItem(storageKey, normalized);
    axiosInstance.defaults.baseURL = normalized;
    return normalized;
  };

  axiosInstance.interceptors.request.use(async (config) => {
    await baseUrlReady;
    const instrumented = config as InstrumentedRequestConfig;
    instrumented[requestBodyKey] = formatData(config.data);
    if (getAuthToken) {
      const token = await getAuthToken();
      if (token) config.headers.Authorization = `Bearer ${token}`;
    }
    instrumented[requestStartedAtKey] = Date.now();
    return config;
  });

  const record = (
    response: AxiosResponse | undefined,
    error: AxiosError | undefined,
  ) => {
    const config = response?.config ?? error?.config;
    if (!config) return;
    const instrumented = config as InstrumentedRequestConfig;
    const startedAt = instrumented[requestStartedAtKey] ?? Date.now();
    const url = redactUrl(axiosInstance.getUri(config));
    addActivity({
      id: `${startedAt}-${Math.random()}`,
      method: (config.method ?? "GET").toUpperCase(),
      url,
      status: response?.status ?? error?.response?.status ?? null,
      responseTimeMs: Date.now() - startedAt,
      requestData: instrumented[requestBodyKey] ?? "",
      responseData: formatData(
        response?.data ?? error?.response?.data ?? { message: error?.message },
      ),
      createdAt: new Date().toISOString(),
    });
  };

  axiosInstance.interceptors.response.use(
    (response) => {
      record(response, undefined);
      return response;
    },
    async (error: unknown) => {
      if (axios.isAxiosError(error)) {
        record(undefined, error);
        if (error.response?.status === 401 && onUnauthorized) {
          await onUnauthorized(error);
        }
      }
      return Promise.reject(error);
    },
  );

  return {
    getBaseUrl,
    saveBaseUrl,
    getActivity: () => activity,
    subscribeToActivity(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearActivity() {
      activity = [];
      notify();
    },
  };
}

export function ApiBaseUrlSettings({
  manager,
  launcherBottomOffset = 16,
  launcherRightOffset = 16,
}: ApiBaseUrlSettingsProps) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState(manager.getActivity);
  const [tab, setTab] = useState<"calls" | "responses">("calls");
  const [selectedResponse, setSelectedResponse] =
    useState<ApiActivityEntry | null>(null);

  useEffect(
    () => manager.subscribeToActivity(() => setActivity(manager.getActivity())),
    [manager],
  );

  async function openSettings() {
    setError("");
    setSelectedResponse(null);
    setTab("calls");
    setVisible(true);
    setBaseUrl(await manager.getBaseUrl());
  }

  async function applyBaseUrl() {
    setError("");
    setSaving(true);
    try {
      setBaseUrl(await manager.saveBaseUrl(baseUrl));
      setVisible(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save the API URL.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <TouchableOpacity
        accessibilityLabel="Configure API base URL"
        accessibilityRole="button"
        onPress={openSettings}
        style={[
          styles.launcher,
          {
            right: insets.right + launcherRightOffset,
            bottom: insets.bottom + launcherBottomOffset,
          },
        ]}
        activeOpacity={0.85}
      >
        <Settings2 color="#FFFFFF" size={21} />
      </TouchableOpacity>
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <KeyboardAvoidingView
          style={styles.keyboardAvoiding}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View
            style={[
              styles.backdrop,
              {
                paddingTop: insets.top + 12,
                paddingBottom: insets.bottom + 12,
                paddingLeft: insets.left + 16,
                paddingRight: insets.right + 16,
              },
            ]}
          >
            <View
              style={[
                styles.modal,
                { maxHeight: height - insets.top - insets.bottom - 24 },
              ]}
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
                showsVerticalScrollIndicator
                contentContainerStyle={styles.content}
              >
                {selectedResponse ? (
                  <>
                    <View style={styles.modalHeader}>
                      <TouchableOpacity
                        accessibilityLabel="Back to API activity"
                        onPress={() => setSelectedResponse(null)}
                        style={styles.backButton}
                        hitSlop={10}
                      >
                        <ChevronLeft color="#344054" size={23} />
                      </TouchableOpacity>
                      <Text style={styles.modalTitle}>Response</Text>
                      <View style={styles.headerSpacer} />
                    </View>
                    <View style={styles.responseSummary}>
                      <Text style={styles.method}>
                        {selectedResponse.method}  ·  {selectedResponse.status ?? "Network error"}
                      </Text>
                      <Text selectable style={styles.url}>
                        {selectedResponse.url}
                      </Text>
                      <Text style={styles.time}>{selectedResponse.responseTimeMs} ms</Text>
                    </View>
                    <Text style={styles.detailLabel}>Response body</Text>
                    <Text selectable style={styles.responseBody}>
                      {selectedResponse.responseData || "(empty response)"}
                    </Text>
                    {selectedResponse.requestData ? (
                      <>
                        <Text style={styles.detailLabel}>Request body</Text>
                        <Text selectable style={styles.responseBody}>
                          {selectedResponse.requestData}
                        </Text>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <View style={styles.modalHeader}>
                      <Text style={styles.modalTitle}>API base URL</Text>
                      <TouchableOpacity
                        accessibilityLabel="Close API settings"
                        onPress={() => setVisible(false)}
                        hitSlop={10}
                      >
                        <X color="#667085" size={21} />
                      </TouchableOpacity>
                    </View>
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      placeholder="https://example.com/api"
                      placeholderTextColor="#A1AAB8"
                      value={baseUrl}
                      onChangeText={setBaseUrl}
                      style={styles.input}
                      accessibilityLabel="API base URL"
                      returnKeyType="done"
                    />
                    {error ? <Text style={styles.error}>{error}</Text> : null}
                    <TouchableOpacity
                      style={[styles.applyButton, saving && styles.disabled]}
                      onPress={applyBaseUrl}
                      disabled={saving || !baseUrl.trim()}
                      activeOpacity={0.88}
                    >
                      {saving ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={styles.applyText}>Apply</Text>
                      )}
                    </TouchableOpacity>
                    <View style={styles.activityHeader}>
                      <Text style={styles.activityHeading}>API activity</Text>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Clear API activity"
                        onPress={() => manager.clearActivity()}
                        style={styles.clearButton}
                      >
                        <Trash2 color="#667085" size={15} />
                        <Text style={styles.clearText}>Clear</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.tabs}>
                      <TouchableOpacity
                        accessibilityRole="tab"
                        accessibilityState={{ selected: tab === "calls" }}
                        onPress={() => setTab("calls")}
                        style={[styles.tab, tab === "calls" && styles.activeTab]}
                      >
                        <Text style={[styles.tabText, tab === "calls" && styles.activeTabText]}>
                          API Calls
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="tab"
                        accessibilityState={{ selected: tab === "responses" }}
                        onPress={() => setTab("responses")}
                        style={[styles.tab, tab === "responses" && styles.activeTab]}
                      >
                        <Text style={[styles.tabText, tab === "responses" && styles.activeTabText]}>
                          API Responses
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {activity.length === 0 ? (
                      <Text style={styles.empty}>API requests will appear here.</Text>
                    ) : (
                      activity.map((entry) => (
                        <View key={entry.id} style={styles.activityRow}>
                          <View style={styles.rowTop}>
                            <Text style={styles.method}>
                              {entry.method}  ·  {entry.status ?? "Network error"}
                            </Text>
                            <Text style={styles.time}>{entry.responseTimeMs} ms</Text>
                          </View>
                          <Text numberOfLines={2} style={styles.url}>{entry.url}</Text>
                          {tab === "responses" ? (
                            <Text numberOfLines={2} style={styles.preview}>
                              {entry.responseData || "(empty response)"}
                            </Text>
                          ) : null}
                          <TouchableOpacity
                            accessibilityRole="button"
                            onPress={() => setSelectedResponse(entry)}
                            style={styles.viewResponse}
                          >
                            <Text style={styles.viewResponseText}>View Response</Text>
                          </TouchableOpacity>
                        </View>
                      ))
                    )}
                  </>
                )}
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  launcher: {
    position: "absolute",
    zIndex: 1000,
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#173B50",
    elevation: 7,
    shadowColor: "#101E36",
    shadowOpacity: 0.24,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  keyboardAvoiding: { flex: 1 },
  backdrop: { flex: 1, justifyContent: "center", backgroundColor: "#10182899" },
  modal: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    flexShrink: 1,
    overflow: "hidden",
  },
  content: { padding: 22 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  modalTitle: { color: "#101828", fontSize: 18, fontWeight: "800" },
  backButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -5,
  },
  headerSpacer: { width: 32, height: 32 },
  input: {
    minHeight: 52,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 10,
    color: "#101828",
    fontSize: 14,
  },
  error: { color: "#C83245", fontSize: 12, marginTop: 8 },
  applyButton: {
    minHeight: 50,
    marginTop: 16,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2457C8",
  },
  disabled: { opacity: 0.8 },
  applyText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 23,
    marginBottom: 11,
  },
  activityHeading: { color: "#101828", fontSize: 16, fontWeight: "800" },
  clearButton: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 9,
  },
  clearText: { color: "#667085", fontSize: 12, fontWeight: "700" },
  tabs: {
    flexDirection: "row",
    padding: 3,
    marginBottom: 12,
    borderRadius: 10,
    backgroundColor: "#F0F3F7",
  },
  tab: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  activeTab: { backgroundColor: "#FFFFFF" },
  tabText: { color: "#667085", fontSize: 12, fontWeight: "700" },
  activeTabText: { color: "#173B50" },
  empty: { paddingVertical: 18, color: "#7A8799", fontSize: 13, textAlign: "center" },
  activityRow: {
    padding: 12,
    marginBottom: 9,
    borderWidth: 1,
    borderColor: "#E6EAF0",
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  method: { color: "#173B50", fontSize: 12, fontWeight: "800" },
  url: { color: "#667085", fontSize: 11, lineHeight: 16 },
  time: { color: "#0E6A63", fontSize: 11, fontWeight: "700" },
  preview: { maxHeight: 46, overflow: "hidden", marginTop: 7, color: "#667085", fontSize: 11, lineHeight: 15 },
  viewResponse: { alignSelf: "flex-start", paddingVertical: 9, marginTop: 2 },
  viewResponseText: { color: "#2457C8", fontSize: 12, fontWeight: "800" },
  responseSummary: { padding: 13, gap: 7, marginBottom: 17, borderRadius: 10, backgroundColor: "#F4F7FA" },
  detailLabel: { marginBottom: 7, color: "#344054", fontSize: 12, fontWeight: "800" },
  responseBody: {
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#E6EAF0",
    borderRadius: 9,
    backgroundColor: "#F8FAFC",
    color: "#344054",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
    lineHeight: 16,
  },
});
