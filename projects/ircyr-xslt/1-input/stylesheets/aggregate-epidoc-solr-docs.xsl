<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

    <xsl:output method="xml" indent="yes" encoding="UTF-8"/>

    <!-- Parameter for the collection URI pattern -->
    <xsl:param name="documents" required="yes"/>

    <xsl:template match="/" name="main">
        <response>
            <result>
                <!-- Process all XML files in the collection -->
                <xsl:for-each select="$documents ! document('../../' || .)">
                    <!-- Copy all doc elements from each file -->
                    <xsl:copy-of select="//doc"/>
                </xsl:for-each>
            </result>
        </response>
    </xsl:template>

</xsl:stylesheet>