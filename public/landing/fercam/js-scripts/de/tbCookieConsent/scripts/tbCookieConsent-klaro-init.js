


    var sLang = "de";

    var sPrivacyPageUrl = "";
            sPrivacyPageUrl = "/de-int/privacy-189.html";


    var klaroConfig = {
        /*
        You can customize the ID of the DIV element that Klaro will create when starting
        up. By default, Klaro will use 'klaro'.
        */
        elementID: "tbCookieConsent",
        /*
         You can customize how Klaro persists consent information in the browser. Specify
         either cookie' (the default) or 'localStorage'.
         */
        storageMethod: "cookie",
        /*
        You can customize the name of the cookie or localStorage entry that Klaro will
        use for storing the consent information. By default, Klaro will use 'klaro'.
        */
        storageName: "tbCookieConsent",
        /*
        If set to `true`, Klaro will render the texts given in the
        `consentModal.description` and `consentNotice.description` translations as HTML.
        This enables you to e.g. add custom links or interactive content.
         */
        htmlTexts: true,
        /*
        You can change the cookie domain for the consent manager itself. Use this if you
        want to get consent once for multiple matching domains. By default, Klaro will
        use the current domain. Only relevant if 'storageMethod' is set to 'cookie'.
        */
        // cookieDomain: '.example.com',
        /*
        You can also set a custom expiration time for the Klaro cookie. By default, it
        will expire after 30 days. Only relevant if 'storageMethod' is set to 'cookie'.
        */
        cookieExpiresAfterDays: "30",
        /*
        You can specify a link to your privacy policy here (relative or absolute), which
        will then be shown in the notice and modal. You can also specify an object with
        language-specific links and an optional fallback using the 'default' key:
        privacyPolicy : {de: "/#datenschutz", en: "/#privacy", default: "/#privacy" },
        */
        privacyPolicy: "/de-int/privacy-189.html",
        /*
        Defines the default state for applications in the consent modal (true=enabled by
        default). You can override this setting in each app.
         */
        default: false,
        /*
        If 'mustConsent' is set to 'true', Klaro will directly display the consent
        manager modal and not allow the user to close it before having actively
        consented or declined the use of third-party applications.
         */
        mustConsent: true,
        /*
        Setting 'acceptAll' to 'true' will show an "accept all" button in the notice and
        modal, which will enable all third-party apps if the user clicks on it. If set
        to 'false', there will be an "accept" button that will only enable the apps that
        are enabled in the consent modal.
         */
        acceptAll: true,
        /*
       Setting 'hideDeclineAll' to 'true' will hide the "decline" button in the consent
       modal and force the user to open the modal in order to change his/her consent or
       disable all third-party apps. We strongly advise you to not use this feature, as
       it opposes the "privacy by default" and "privacy by design" principles of the
       GDPR (but might be acceptable in other legislations such as under the CCPA)
        */
        hideDeclineAll:  false,
        /*
        Setting 'hideLearnMore' to 'true' will hide the "learn more / customize" link in
        the consent notice. We strongly advise against using this under most
        circumstances, as it keeps the user from customizing his/her consent choices.
         */
        hideLearnMore: false,

        /* Skripte hier definieren */
        apps: [
                    {
                    name: 'Facebook Pixel',
                    title: 'Facebook Pixel',
                    description: '',
                    purposes: ['besucherstatistken'],
                    cookies: [],
                    googleConsent:false,
                    googleConsentAttributes:[  ]
                    },
                    {
                    name: 'GoogleTagManager',
                    title: 'Google TagManager',
                    description: '',
                    purposes: ['besucherstatistken'],
                    cookies: [],
                    googleConsent:true,
                    googleConsentAttributes:[ 'analytics_storage','ad_user_data' ]
                    },
                    {
                    name: 'LinkedIn',
                    title: 'LinkedIn',
                    description: '',
                    purposes: ['besucherstatistken'],
                    cookies: [],
                    googleConsent:false,
                    googleConsentAttributes:[  ]
                    },
                    {
                    name: 'GoogleMaps',
                    title: 'GoogleMaps',
                    description: '',
                    purposes: ['map'],
                    cookies: [],
                    googleConsent:false,
                    googleConsentAttributes:[  ]
                    },
                    {
                    name: 'technischeCookies',
                    title: 'Technische Cookies',
                    description: '',
                    purposes: ['technischeCookies'],
                    cookies: [],
                    googleConsent:false,
                    googleConsentAttributes:[  ]
                    },
                    {
                    name: 'GoogleAnalytics',
                    title: 'Google Analytics',
                    description: '',
                    purposes: ['besucherstatistken'],
                    cookies: [/^ga/i],
                    googleConsent:true,
                    googleConsentAttributes:[ 'analytics_storage' ]
                    },
                    {
                    name: 'Google Ads',
                    title: 'Google Ads',
                    description: '',
                    purposes: ['Marketing'],
                    cookies: [],
                    googleConsent:true,
                    googleConsentAttributes:[ 'ad_user_data','ad_personalization','ad_storage' ]
                    },

        ],
        callback: function (consent, app) {

            // Google Consent updaten
            if (app.googleConsentAttributes.length > 0) {

                // Schauen ob sich die Struktur geÃ¤ndert hat
                //console.log("davor ", GoogleConsentAttribute);
                var bChangeConsentMode = false;

                for (i = 0; i < app.googleConsentAttributes.length; i++) {

                    // Stimmt User zu oder lehnt er ab
                    var sGoogleMode2Change = "";
                    if (consent) {
                        sGoogleMode2Change = "granted";
                    } else {
                        sGoogleMode2Change = "denied"
                    }
                    //console.log("kontrolle ", app.googleConsentAttributes[i]);
                    //console.log(GoogleConsentAttribute[app.googleConsentAttributes[i]]);

                    if (GoogleConsentAttribute[app.googleConsentAttributes[i]] != sGoogleMode2Change) {
                        GoogleConsentAttribute[app.googleConsentAttributes[i]] = sGoogleMode2Change;
                        //console.log("change  Google Consent ", app.googleConsentAttributes[i] + " to " + sGoogleMode2Change);
                        bChangeConsentMode = true;
                    }
                }
                //console.log("danach ", GoogleConsentAttribute);
                if (bChangeConsentMode) {
                    //console.log("Set new  Google Consent ", GoogleConsentAttribute);
                    gtag('consent', 'update', GoogleConsentAttribute);
                }
            }
            // ---------------------------------------------------------------------------------

            // Ausblenden YouTube - Info wenn User da zustimmt
            if (app.name == "video-youtube") {
                if (consent) {
                    $(".dsgvo-info-youtube").addClass("dn");
                    $(".youtube-video-container,.youtube-api-container-wrap").css("display", "block");

                    // Videos mit Api laden
                    loadYouTubeTwitterVideos();
                } else {
                    $(".dsgvo-info-youtube").removeClass("dn");
                    $(".youtube-video-container,.youtube-api-container-wrap").css("display", "none");
                }
            }

            // Ausblenden ISSUU - Info wenn User da zustimmt
            if (app.name == "issuu") {
                if (consent) {
                    $(".dsgvo-info-issuu").addClass("dn");
                    $(".issuu-container").css("display", "block");
                } else {
                    $(".dsgvo-info-issuu").removeClass("dn");
                    $(".issuu-container").css("display", "none");
                }
            }
        }
        , translations: {}
    };

     setInterval(function () {
         try {
             if ($(".cm-header").length > 0 && $(".cm-header").first().find("p").length > 0) {
                 var cont = $(".cm-header").first().find("p").first().html();
                 cont = cont.replace("[cookyPolicy]", "<a href='/de-int/cookie-policy-83.html' target='_blank'>Cookierichtlinien</a>")
                 $(".cm-header p").html(cont);
             }
         } catch (e) { }
     }, 1000);



    /*
      You can overwrite existing translations and add translations for your app
      descriptions and purposes. See `src/translations/` for a full list of
      translations that can be overwritten:
      https://github.com/KIProtect/klaro/tree/master/src/translations
    */ klaroConfig.translations[sLang] = {
        acceptAll: "alle akzeptieren",
        acceptSelected: "ausgewählte akzeptieren",
        app: {
            disableAll: {
                description: "Mit diesem Schalter können Sie alle Dienste aktivieren oder deaktivieren.",
                title: "Alle Dienste aktivieren oder deaktivieren",
            },
            optOut: {
                description: "Diese Dienste werden standardmäßig geladen (Sie können sich jedoch",
                title: "(Opt-out)",
            },
            purpose: "Zweck",
            purposes: "Zwecke",
            required: {
                description: "Dieser Service ist immer erforderlich",
                title: "(immer erforderlich)",
            }
        },
        close: "schließen",
        consentModal: {
            description:"Hier können Sie die Dienste, die wir auf dieser Website nutzen möchten, auswählen.",
            privacyPolicy: {
                name: "Datenschutzerklärung",
                text: "Um mehr zu erfahren, lesen Sie bitte unsere {privacyPolicy} und die  [cookyPolicy].",
            },
            title: "Cookies",
        },
        consentNotice: {
            changeDescription: "Seit Ihrem letzten Besuch gab es Änderungen, bitte erneuern Sie",
            configure: "konfigurieren",
            description: "Hallo! Könnten wir bitte einige zusätzliche Dienste für {purposes} aktivieren?",
            imprint: {
                name: "Impressum",
            },
            learnMore: "Dienste wählen",
            privacyPolicy: {
                name: "Datenschutzerklärung",
            },
            testing: "Testmodus!"
        },
        decline: "Nur technische Cookies",
        ok: "Einverstanden",
        poweredBy: " ",
        purposeItem: {
            app: "Dienst",
            apps: "Dienste",
        },
        purposes: {

                    besucherstatistken: "Besucher-Statistiken",
                    map: "Karten",
                    technischeCookies: "Technische Cookies",
                    Marketing: "Marketing",

        }
    };

    // FÃ¼r den Fall das es keine besonderen Dienste gibt -> andere Texte
    if (klaroConfig.apps.length == 0) {
        klaroConfig.translations[sLang].consentNotice.learnMore = "mehr erfahren";
        klaroConfig.translations[sLang].consentModal.title = " ";
        klaroConfig.translations[sLang].consentNotice.description = "Diese Website verwendet Cookies, um eine bestmögliche Erfahrung bieten zu können.  " + " <a class='privay-link' href='" + sPrivacyPageUrl + "'>" + "Datenschutzerklärung" + "</a>";
        klaroConfig.translations[sLang].ok = "verstanden"
    }

//console.log(klaroConfig);

    // SchlieÃŸen Event
       function closeKlaro() {
            if ($(".cn-decline").length > 0) {
                $(".cn-decline").click();
            } else {
                $("#tbCookieConsent .klaro").html("<div></div>");
            }
        }

     // Events beim Laden von Klaro
        window.addEventListener("load", (event) => {

            // Cookiebanner anzeigen (YouTube Info)
            $(".dsgvo-info-youtube").click(function () {
                klaro.show();
            });

            // Cookiebanner anzeigen (Issuu Info)
            $(".dsgvo-info-issuu").click(function () {
                klaro.show();
            })

            // Cookiebanner anzeigen (Footerlink)
            $(".js-show-klaro").click(function () {
                klaro.show();
            });
        });

