<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="3.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:i18n="http://apache.org/cocoon/i18n/2.1"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    exclude-result-prefixes="i18n xs">

    <!-- Import the SigiDoc start-edition stylesheet -->
    <xsl:import href="../sigidoc-stylesheets/start-edition.xsl"/>

    <xsl:output method="xml" encoding="UTF-8" indent="no"/>

    <!-- Language parameter for i18n -->
    <xsl:param name="language" select="'en'"/>

    <!-- Load the messages file based on language parameter -->
    <xsl:variable name="messages-file" select="concat('../i18n/messages_', $language, '.xml')"/>
    <xsl:variable name="messages" select="doc($messages-file)"/>

    <!-- Key for efficient message lookup -->
    <xsl:key name="message-by-key" match="message" use="@key"/>

    <!-- Main template: capture SigiDoc output, then process for i18n -->
    <xsl:template match="/">
        <!-- Call the sigidoc-body-structure template from start-edition.xsl -->
        <xsl:variable name="sigidoc-output">
            <xsl:call-template name="sigidoc-body-structure"/>
        </xsl:variable>

        <!-- Now process the output to replace i18n:text elements -->
        <xsl:apply-templates select="$sigidoc-output" mode="i18n-replace"/>
    </xsl:template>

    <!-- Identity transform for i18n-replace mode -->
    <xsl:template match="node() | @*" mode="i18n-replace">
        <xsl:copy>
            <xsl:apply-templates select="@* | node()" mode="i18n-replace"/>
        </xsl:copy>
    </xsl:template>

    <!-- Replace i18n:text elements with translated text -->
    <xsl:template match="i18n:text[@i18n:key]" mode="i18n-replace">
        <xsl:variable name="key" select="@i18n:key"/>
        <xsl:variable name="translation" select="key('message-by-key', $key, $messages)[1]"/>

        <xsl:choose>
            <xsl:when test="$translation">
                <xsl:value-of select="$translation"/>
            </xsl:when>
            <xsl:when test="normalize-space(.)">
                <!-- Fallback: use default text from SigiDoc stylesheet -->
                <xsl:value-of select="."/>
            </xsl:when>
            <xsl:otherwise>
                <!-- Last resort: output the key in brackets -->
                <xsl:text>[</xsl:text>
                <xsl:value-of select="$key"/>
                <xsl:text>]</xsl:text>
            </xsl:otherwise>
        </xsl:choose>
    </xsl:template>

</xsl:stylesheet>
