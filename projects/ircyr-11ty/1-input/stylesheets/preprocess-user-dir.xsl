<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

  <!-- Parameter: the replacement value for system-property('user.dir') -->
  <xsl:param name="efes-base-path" />

  <!-- Identity transform - copy everything unchanged by default -->
  <xsl:template match="node() | @*">
    <xsl:copy copy-namespaces="yes">
      <xsl:apply-templates select="node() | @*"/>
    </xsl:copy>
  </xsl:template>

  <!-- Replace system-property('user.dir') in all attribute values -->
  <xsl:template match="@*">
    <xsl:choose>
      <xsl:when test="contains(., 'system-property')">
        <xsl:attribute name="{name()}" namespace="{namespace-uri()}">
          <xsl:value-of select="replace(., 'system-property\s*\(\s*([''&quot;])user\.dir\1\s*\)', '''' || $efes-base-path || '''')"/>
        </xsl:attribute>
      </xsl:when>
      <xsl:otherwise>
        <xsl:copy/>
      </xsl:otherwise>
    </xsl:choose>
  </xsl:template>

  <!-- Replace system-property('user.dir') in xsl:value-of text content -->
  <xsl:template match="xsl:value-of/text()">
    <xsl:value-of select="replace(., 'system-property\s*\(\s*([''&quot;])user\.dir\1\s*\)', '''' || $efes-base-path || '''')"/>
  </xsl:template>

</xsl:stylesheet>