package ru.padlhub.app;

import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class AndroidWindowInsetsTest {
    @Test public void cutoutsKeyboardAndRotationResizeViewportExactlyOnce() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            instrumentation.runOnMainSync(() -> {
                View viewport = (View) activity.getBridge().getWebView().getParent();
                int bars = WindowInsetsCompat.Type.systemBars();
                int cutout = WindowInsetsCompat.Type.displayCutout();
                int ime = WindowInsetsCompat.Type.ime();
                WindowInsetsCompat portrait = new WindowInsetsCompat.Builder()
                    .setInsets(bars, Insets.of(0, 24, 0, 34))
                    .setInsets(cutout, Insets.of(0, 59, 0, 0)).build();
                WindowInsetsCompat remaining = ViewCompat.dispatchApplyWindowInsets(viewport, portrait);
                assertEquals(59, viewport.getPaddingTop());
                assertEquals(34, viewport.getPaddingBottom());
                assertEquals(Insets.NONE, remaining.getInsets(bars | cutout | ime));
                ViewCompat.dispatchApplyWindowInsets(viewport, portrait);
                assertEquals("Repeated delivery must not accumulate padding", 59, viewport.getPaddingTop());

                activity.setStatusBarUnderlap(true);
                View scrim = viewport.findViewWithTag("phub-status-bar-scrim");
                assertEquals("Only artwork may enter the status region", 0, viewport.getPaddingTop());
                assertEquals(59, scrim.getLayoutParams().height);
                assertEquals(View.VISIBLE, scrim.getVisibility());
                int stripColor = ((ColorDrawable) scrim.getBackground()).getColor();
                assertEquals(Color.rgb(148, 116, 255), stripColor);
                assertEquals("Scrolling cards cannot show through the status strip", 255, Color.alpha(stripColor));
                assertFalse(scrim.isClickable());
                assertFalse(scrim.isFocusable());
                assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, scrim.getImportantForAccessibility());
                assertEquals(59 / activity.getResources().getDisplayMetrics().density,
                    activity.statusBarContentInset(), 0.001);

                WindowInsetsCompat keyboard = new WindowInsetsCompat.Builder(portrait)
                    .setInsets(ime, Insets.of(0, 0, 0, 320)).build();
                ViewCompat.dispatchApplyWindowInsets(viewport, keyboard);
                assertEquals(0, viewport.getPaddingTop());
                assertEquals("Keyboard replaces rather than adds navigation inset", 320, viewport.getPaddingBottom());

                WindowInsetsCompat landscape = new WindowInsetsCompat.Builder()
                    .setInsets(bars, Insets.of(0, 24, 0, 21))
                    .setInsets(cutout, Insets.of(59, 0, 59, 0)).build();
                ViewCompat.dispatchApplyWindowInsets(viewport, landscape);
                assertEquals(59, viewport.getPaddingLeft());
                assertEquals(0, viewport.getPaddingTop());
                assertEquals(24, scrim.getLayoutParams().height);
                assertEquals(59, viewport.getPaddingRight());
                assertEquals(21, viewport.getPaddingBottom());
                activity.setStatusBarUnderlap(false);
                assertEquals("Routes/dialogs restore native top containment", 24, viewport.getPaddingTop());
                assertEquals(View.GONE, scrim.getVisibility());
                assertEquals(0, activity.statusBarContentInset(), 0.001);
                ViewCompat.dispatchApplyWindowInsets(viewport, new WindowInsetsCompat.Builder().build());
                assertEquals(0, viewport.getPaddingLeft());
                assertEquals(0, viewport.getPaddingTop());
                assertEquals(0, viewport.getPaddingRight());
                assertEquals(0, viewport.getPaddingBottom());
            });
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }
}
