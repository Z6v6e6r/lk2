package ru.padlhub.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Presentation only: no network, credentials, navigation or new JavaScript interface. */
@CapacitorPlugin(name = "PadlHubViewport")
public final class PadlHubViewportPlugin extends Plugin {
    @Override public void load() {
        ((MainActivity) getActivity()).observeViewportInsets(top ->
            notifyListeners("insetsChanged", insets(top), true));
    }

    @PluginMethod public void setUnderlap(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("Viewport setting is required"); return; }
        getActivity().runOnUiThread(() -> {
            MainActivity activity = (MainActivity) getActivity();
            activity.setStatusBarUnderlap(enabled);
            call.resolve(insets(activity.statusBarContentInset()));
        });
    }

    private JSObject insets(double top) {
        JSObject value = new JSObject();
        value.put("top", top);
        return value;
    }
}
