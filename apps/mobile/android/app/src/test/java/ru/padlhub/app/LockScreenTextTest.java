package ru.padlhub.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class LockScreenTextTest {
    @Test public void usesTheTemplateHeadline() {
        assertEquals("Напоминание о записи", LockScreenText.title("Напоминание о записи"));
    }

    @Test public void fallsBackWhenTheHeadlineIsMissing() {
        assertEquals(LockScreenText.FALLBACK_TITLE, LockScreenText.title(null));
        assertEquals(LockScreenText.FALLBACK_TITLE, LockScreenText.title("   "));
        assertEquals(LockScreenText.FALLBACK_TITLE, LockScreenText.title(""));
    }

    @Test public void collapsesControlCharactersToSingleSpaces() {
        assertEquals("Две строки", LockScreenText.title("  Две\nстроки  "));
        assertEquals("Строка", LockScreenText.title("Строка\u0007"));
    }

    @Test public void capsTheProviderSuppliedLength() {
        assertEquals(LockScreenText.MAX_TITLE, LockScreenText.title(repeat('а', 500)).length());
    }

    @Test public void rendersTheTypeLine() {
        assertEquals("Не пропусти занятие", LockScreenText.body("Не пропусти занятие"));
        assertEquals("Новое сообщение в чате", LockScreenText.body("Новое сообщение в чате"));
    }

    @Test public void fallsBackWhenTheTypeLineIsMissing() {
        assertEquals(LockScreenText.FALLBACK_BODY, LockScreenText.body(null));
        assertEquals(LockScreenText.FALLBACK_BODY, LockScreenText.body("   "));
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index++) result.append(value);
        return result.toString();
    }
}
