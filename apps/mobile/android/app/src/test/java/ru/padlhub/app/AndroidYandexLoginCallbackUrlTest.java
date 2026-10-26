package ru.padlhub.app;

import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Pure JVM contract for the only two intent callbacks the native login accepts. The browser fallback
 * is normalized to the verified App Link shape before any possibility is written, so custody,
 * expiry, state comparison and exchange remain unchanged.
 */
public class AndroidYandexLoginCallbackUrlTest {
    static final String CODE = token('c');
    static final String STATE = token('s');
    static final String APP_LINK = AndroidYandexLogin.TARGET + "#code=" + CODE + "&state=" + STATE;
    static final String FALLBACK = "padlhub://oauth/yandex?code=" + CODE + "&state=" + STATE;

    static String token(char value) {
        return new String(new char[43]).replace('\0', value);
    }

    @Test public void keepsTheVerifiedAppLinkCallbackUnchanged() {
        assertEquals(APP_LINK, AndroidYandexLogin.callbackUrl(APP_LINK));
    }

    @Test public void normalizesTheBrowserFallbackToTheAppLinkShape() {
        assertEquals(APP_LINK, AndroidYandexLogin.callbackUrl(FALLBACK));
    }

    @Test public void acceptsOnlyTheExactCallbackGrammar() {
        for (String raw : new String[] {
            null,
            "",
            AndroidYandexLogin.TARGET,
            FALLBACK.replace("?code=", "#code="),
            FALLBACK + "&next=evil",
            FALLBACK.replace("padlhub://oauth/yandex", "padlhub://oauth/other"),
            FALLBACK.replace("padlhub://oauth/yandex", "padlhub://evil/yandex"),
            FALLBACK.replace("padlhub://", "https://"),
            FALLBACK.replace("padlhub://", "PADLHUB://"),
            "padlhub://oauth/yandex?state=" + STATE + "&code=" + CODE,
            "padlhub://oauth/yandex?code=" + CODE + "&state=" + STATE + "/",
            "padlhub://oauth/yandex?code=" + CODE + "&state=" + STATE + "#fragment",
            "padlhub://oauth/yandex?code=" + CODE.substring(1) + "&state=" + STATE,
            "padlhub://oauth/yandex?code=" + CODE + "&state=" + STATE + "&code=" + CODE,
            "padlhub://oauth/yandex?code=" + CODE + "&state=" + STATE + "&state=" + STATE,
            "padlhub://oauth/yandex?code=" + CODE.replace("c", "%63") + "&state=" + STATE,
            "padlhub://oauth/yandex?code=" + CODE + "&state=" + STATE + "&",
            "padlhub://oauth/yandex?code=" + CODE + ";state=" + STATE,
            APP_LINK + "&next=evil",
            APP_LINK.replace("lk2.padlhub.su", "evil.example"),
            APP_LINK.replace("#code=", "?code="),
            AndroidYandexLogin.TARGET + "?code=" + CODE + "&state=" + STATE,
            token('x'),
            "https://lk2.padlhub.su/android/oauth/yandex#code=" + CODE + "&state=" + STATE + "#x",
        }) assertNull(String.valueOf(raw), AndroidYandexLogin.callbackUrl(raw));
    }
}
