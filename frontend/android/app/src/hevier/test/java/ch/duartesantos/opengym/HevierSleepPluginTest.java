package ch.duartesantos.opengym;

import static org.junit.Assert.*;

import org.junit.Test;

/** Unit tests for HevierSleepPlugin UsageEvents type mapping. */
public class HevierSleepPluginTest {
    @Test
    public void mapsScreenAndKeyguardEventsOnly() {
        assertEquals("screen_on", HevierSleepPlugin.eventTypeName(15));
        assertEquals("screen_off", HevierSleepPlugin.eventTypeName(16));
        assertEquals("keyguard_shown", HevierSleepPlugin.eventTypeName(17));
        assertEquals("unlock", HevierSleepPlugin.eventTypeName(18));
        assertNull(HevierSleepPlugin.eventTypeName(0));
        assertNull(HevierSleepPlugin.eventTypeName(1));
        assertNull(HevierSleepPlugin.eventTypeName(2));
        assertNull(HevierSleepPlugin.eventTypeName(14));
        assertNull(HevierSleepPlugin.eventTypeName(19));
    }
}
