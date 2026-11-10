package ru.padlhub.app;

/** Renders the lock-screen lines of a data-only FCM message without trusting provider lengths. */
final class LockScreenText {
    static final int MAX_TITLE = 120, MAX_BODY = 160;
    static final String FALLBACK_TITLE = "ПадлхАБ", FALLBACK_BODY = "У вас новое уведомление";

    private LockScreenText() { }

    static String title(String raw) { return line(raw, MAX_TITLE, FALLBACK_TITLE); }

    static String body(String raw) { return line(raw, MAX_BODY, FALLBACK_BODY); }

    private static String line(String raw, int max, String fallback) {
        String value = clean(raw, max);
        return value.isEmpty() ? fallback : value;
    }

    private static String clean(String raw, int max) {
        if (raw == null || raw.isEmpty()) return "";
        StringBuilder value = new StringBuilder(Math.min(raw.length(), max));
        boolean space = false;
        for (int index = 0; index < raw.length() && value.length() < max; index++) {
            char current = raw.charAt(index);
            if (Character.isWhitespace(current) || Character.isISOControl(current)) {
                space = true;
                continue;
            }
            if (space && value.length() > 0) value.append(' ');
            space = false;
            value.append(current);
        }
        return value.toString();
    }
}
