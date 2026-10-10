package ru.padlhub.app;

import android.app.Instrumentation;
import android.content.Intent;
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

                WindowInsetsCompat keyboard = new WindowInsetsCompat.Builder(portrait)
                    .setInsets(ime, Insets.of(0, 0, 0, 320)).build();
                ViewCompat.dispatchApplyWindowInsets(viewport, keyboard);
                assertEquals(59, viewport.getPaddingTop());
                assertEquals("Keyboard replaces rather than adds navigation inset", 320, viewport.getPaddingBottom());

                WindowInsetsCompat landscape = new WindowInsetsCompat.Builder()
                    .setInsets(bars, Insets.of(0, 24, 0, 21))
                    .setInsets(cutout, Insets.of(59, 0, 59, 0)).build();
                ViewCompat.dispatchApplyWindowInsets(viewport, landscape);
                assertEquals(59, viewport.getPaddingLeft());
                assertEquals(24, viewport.getPaddingTop());
                assertEquals(59, viewport.getPaddingRight());
                assertEquals(21, viewport.getPaddingBottom());
                ViewCompat.dispatchApplyWindowInsets(viewport, new WindowInsetsCompat.Builder().build());
                assertEquals(0, viewport.getPaddingLeft());
                assertEquals(0, viewport.getPaddingTop());
                assertEquals(0, viewport.getPaddingRight());
                assertEquals(0, viewport.getPaddingBottom());
            });
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }
}
