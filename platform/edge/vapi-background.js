/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-2016 The uBlock Origin authors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

// For background page

/******************************************************************************/

(function() {

'use strict';

/******************************************************************************/

var vAPI = self.vAPI = self.vAPI || {};

var browser = self.browser;
var manifest = browser.runtime.getManifest();

vAPI.chrome = true;
vAPI.cantWebsocket = true; 

var noopFunc = function(){};

/******************************************************************************/

vAPI.app = {
    name: manifest.name,
    version: manifest.version
};

/******************************************************************************/

vAPI.app.restart = function() {
    browser.runtime.reload && browser.runtime.reload();
};

/******************************************************************************/
/******************************************************************************/

// chrome.storage.local.get(null, function(bin){ console.debug('%o', bin); });

vAPI.storage = (function() {
    // Found through trial and error.
    // Edge aparrently supports 1MB per value, but we get errors
    // even with 400,000 chars.
    const MAX_BYTES_PER_VALUE = 300000;
    const storage = browser.storage.local;

    function get(key, callback) {
        if (typeof key !== 'string') {
            storage.get(key, callback);
        } else {
           getValueAndJoinIfRequired(key, callback);
        }
    }

    function getValueAndJoinIfRequired(key, callback) {
        storage.get(key, (response) => {
            if (!response[key]) {
                getJoinedValue(key, callback);
            } else {
                callback(response);
            }
        });
    }

    function getJoinedValue(key, callback) {
        const parts = [];
        getNextValue();

        function getNextValue(index = 0) {
            const nextKey = `${key}__${index}`;
            storage.get(nextKey, (response) => {
                if (response[nextKey]) {
                    storePartAndContinue(response[nextKey], index);
                } else {
                    joinAndRespond();
                }
            });
        }

        function storePartAndContinue(part, currentIndex) {
            parts.push(part);
            getNextValue(currentIndex + 1);
        }

        function joinAndRespond() {
            const response = {};
            let value;
            try {
                value = JSON.parse(parts.join(''));
            } catch (e) {
                value = null;
            }
            response[key] = value;
            callback(response); 
        }
    }

    function set(data, callback) {
        setWithSplitLargeValues(data, callback);
    }   

    function remove(key, callback) {
        if (typeof key !== 'string') {
            storage.remove(key, callback);
        } else {
            storage.get(key, removePartsIfRequired);
        }

        function removePartsIfRequired(response) {
            if (response[key]) {
                storage.remove(key);
            } else {
                removeNextPart();
            }
        }       

        function removeNextPart(index = 0) {
            storage.remove(`${key}__${index}`);
            const nextKey = `${key}__${index + 1}`; 
            storage.get(nextKey, (result) => {
                if (result[nextKey]) {
                    removeNextPart(index + 1);
                }
            });
        }
    }

    function setWithSplitLargeValues(data, callback) {
        const split = Object.keys(data).reduce((output, key) => {
            const stringified = JSON.stringify(data[key]);
            if (stringified.length > MAX_BYTES_PER_VALUE) {
                storage.remove(key);
                const parts = splitStringByLength(stringified, MAX_BYTES_PER_VALUE);
                parts.forEach((part, index) => {
                    output[`${key}__${index}`] = part;
                });
                output[`${key}__${parts.length}`] = null;
            } else {
                output[key] = data[key];
            }
            return output;
        }, {});
        storage.set(split, callback);
    }

    function splitStringByLength(str, length) {
        const output = [];
        while(str.length > length) {
            output.push(str.substr(0, length));
            str = str.substr(length);
        }
        output.push(str);
        return output;
    }
 
    return {
        get, set, remove,
        clear: storage.clear,
        getBytesInUse: storage.getBytesInUse
    }
}());

/******************************************************************************/
/******************************************************************************/

// https://github.com/gorhill/uMatrix/issues/234
// https://developer.chrome.com/extensions/privacy#property-network

// 2015-08-12: Wrapped Chrome API in try-catch statements. I had a fluke
// event in which it appeared Chrome 46 decided to restart uBlock (for
// unknown reasons) and again for unknown reasons the browser acted as if
// uBlock did not declare the `privacy` permission in its manifest, putting
// uBlock in a bad, non-functional state -- because call to `chrome.privacy`
// API threw an exception.

vAPI.browserSettings = {
    webRTCSupported: undefined,

    // https://github.com/gorhill/uBlock/issues/875 
    // Must not leave `lastError` unchecked. 
    noopCallback: function() { 
        void chrome.runtime.lastError; 
    },

    // https://github.com/gorhill/uBlock/issues/533
    // We must first check wether this Chromium-based browser was compiled
    // with WebRTC support. To do this, we use an iframe, this way the
    // empty RTCPeerConnection object we create to test for support will
    // be properly garbage collected. This prevents issues such as
    // a computer unable to enter into sleep mode, as reported in the
    // Chrome store:
    // https://github.com/gorhill/uBlock/issues/533#issuecomment-167931681
    setWebrtcIPAddress: function(setting) {
        // We don't know yet whether this browser supports WebRTC: find out.
        if ( this.webRTCSupported === undefined ) {
            this.webRTCSupported = { setting: setting };
            var iframe = document.createElement('iframe');
            var me = this;
            var messageHandler = function(ev) {
                if ( ev.origin !== self.location.origin ) {
                    return;
                }
                window.removeEventListener('message', messageHandler);
                var setting = me.webRTCSupported.setting;
                me.webRTCSupported = ev.data === 'webRTCSupported';
                me.setWebrtcIPAddress(setting);
                iframe.parentNode.removeChild(iframe);
                iframe = null;
            };
            window.addEventListener('message', messageHandler);
            iframe.src = 'is-webrtc-supported.html';
            document.body.appendChild(iframe);
            return;
        }

        // We are waiting for a response from our iframe. This makes the code
        // safe to re-entrancy.
        if ( typeof this.webRTCSupported === 'object' ) {
            this.webRTCSupported.setting = setting;
            return;
        }

        // https://github.com/gorhill/uBlock/issues/533
        // WebRTC not supported: `webRTCMultipleRoutesEnabled` can NOT be
        // safely accessed. Accessing the property will cause full browser
        // crash.
        if ( this.webRTCSupported !== true ) {
            return;
        }

        var cp = chrome.privacy, cpi = cp.IPHandlingPolicy, cpn = cp.network; 
 
        // Older version of Chromium do not support this setting, and is 
        // marked as "deprecated" since Chromium 48. 
        if ( typeof cpn.webRTCMultipleRoutesEnabled === 'object' ) { 
            try { 
                cpn.webRTCMultipleRoutesEnabled.set({ 
                    value: !!setting, 
                    scope: 'regular' 
                }, this.noopCallback); 
            } catch(ex) { 
                console.error(ex); 
            } 
        }

        // This setting became available in Chromium 48. 
        if ( typeof cpn.webRTCIPHandlingPolicy === 'object' ) { 
            try { 
                cpn.webRTCIPHandlingPolicy.set({ 
                    value: !!setting ? cpi.DEFAULT : cpi.DEFAULT_PUBLIC_INTERFACE_ONLY, 
                    scope: 'regular' 
                }, this.noopCallback); 
            } catch(ex) { 
                console.error(ex); 
            } 
        }
    },

    set: function(details) {
        for ( var setting in details ) {
            if ( details.hasOwnProperty(setting) === false ) {
                continue;
            }
            switch ( setting ) {
            case 'prefetching':
                try {
                    browser.privacy.network.networkPredictionEnabled.set({
                        value: !!details[setting],
                        scope: 'regular'
                    }, this.noopCallback);
                } catch(ex) {
                    console.error(ex);
                }
                break;

            case 'hyperlinkAuditing':
                try {
                    browser.privacy.websites.hyperlinkAuditingEnabled.set({
                        value: !!details[setting],
                        scope: 'regular'
                    }, this.noopCallback);
                } catch(ex) {
                    console.error(ex);
                }
                break;

            case 'webrtcIPAddress':
                this.setWebrtcIPAddress(details[setting]);
                break;

            default:
                break;
            }
        }
    }
};

/******************************************************************************/
/******************************************************************************/

vAPI.tabs = {};

/******************************************************************************/

vAPI.isBehindTheSceneTabId = function(tabId) {
    return tabId.toString() === '-1';
};

vAPI.noTabId = '-1';

/******************************************************************************/

var toChromiumTabId = function(tabId) {
    if ( typeof tabId === 'string' ) {
        tabId = parseInt(tabId, 10);
    }
    if ( typeof tabId !== 'number' || isNaN(tabId) || tabId === -1 ) {
        return 0;
    }
    return tabId;
};

/******************************************************************************/

vAPI.tabs.registerListeners = function() {
    var onNavigationClient = this.onNavigation || noopFunc;
    var onUpdatedClient = this.onUpdated || noopFunc;

    // https://developer.chrome.com/extensions/webNavigation
    // [onCreatedNavigationTarget ->]
    //  onBeforeNavigate ->
    //  onCommitted ->
    //  onDOMContentLoaded ->
    //  onCompleted

    // The chrome.webRequest.onBeforeRequest() won't be called for everything
    // else than `http`/`https`. Thus, in such case, we will bind the tab as
    // early as possible in order to increase the likelihood of a context
    // properly setup if network requests are fired from within the tab.
    // Example: Chromium + case #6 at
    //          http://raymondhill.net/ublock/popup.html
    var reGoodForWebRequestAPI = /^https?:\/\//;

    // https://forums.lanik.us/viewtopic.php?f=62&t=32826 
    //   Chromium-based browsers: sanitize target URL. I've seen data: URI with
    //   newline characters in standard fields, possibly as a way of evading
    //   filters. As per spec, there should be no whitespaces in a data: URI's
    //   standard fields.
    var sanitizeURL = function(url) {
        if ( url.startsWith('data:') === false ) { return url; }
        var pos = url.indexOf(',');
        if ( pos === -1 ) { return url; }
        var s = url.slice(0, pos);
        if ( s.search(/\s/) === -1 ) { return url; }
        return s.replace(/\s+/, '') + url.slice(pos);
    }; 

    var onCreatedNavigationTarget = function(details) {
        //console.debug('onCreatedNavigationTarget: popup candidate tab id %d = "%s"', details.tabId, details.url);
        if ( reGoodForWebRequestAPI.test(details.url) === false ) {
            details.frameId = 0;
            details.url = sanitizeURL(details.url);
            onNavigationClient(details);
        }
        if ( typeof vAPI.tabs.onPopupCreated === 'function' ) {
            vAPI.tabs.onPopupCreated(details.tabId.toString(), details.sourceTabId.toString());
        }
    };

    var onBeforeNavigate = function(details) {
        if ( details.frameId !== 0 ) {
            return;
        }
    };

    var onCommitted = function(details) {
        if ( details.frameId !== 0 ) {
            return;
        }
        details.url = sanitizeURL(details.url);
        onNavigationClient(details);
    };

    var onActivated = function(details) {
        vAPI.contextMenu.onMustUpdate(details.tabId);
    };

    var onUpdated = function(tabId, changeInfo, tab) {
        if ( changeInfo.url ) {
            changeInfo.url = sanitizeURL(changeInfo.url);
        }
        onUpdatedClient(tabId, changeInfo, tab);
    };

    browser.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
    browser.webNavigation.onCommitted.addListener(onCommitted);
    browser.webNavigation.onCreatedNavigationTarget.addListener(onCreatedNavigationTarget);
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);

    if ( typeof this.onClosed === 'function' ) {
        browser.tabs.onRemoved.addListener(this.onClosed);
    }

};

/******************************************************************************/

vAPI.tabs.get = function(tabId, callback) {
    var onTabReady = function(tab) {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( browser.runtime.lastError ) {
            /* noop */
        }
        // Caller must be prepared to deal with nil tab value
        callback(tab);
    };

    if ( tabId !== null ) {
        tabId = toChromiumTabId(tabId);
        if ( tabId === 0 ) {
            onTabReady(null);
        } else {
            browser.tabs.get(tabId, onTabReady);
        }
        return;
    }

    var onTabReceived = function(tabs) {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        void browser.runtime.lastError;
        callback(tabs[0]);
    };
    browser.tabs.query({ active: true, currentWindow: true }, onTabReceived);
};

/******************************************************************************/

// properties of the details object:
//   url: 'URL', // the address that will be opened
//   tabId: 1, // the tab is used if set, instead of creating a new one
//   index: -1, // undefined: end of the list, -1: following tab, or after index
//   active: false, // opens the tab in background - true and undefined: foreground
//   select: true, // if a tab is already opened with that url, then select it instead of opening a new one
//   popup: true // open in a new window

vAPI.tabs.open = function(details) {
    var targetURL = details.url;
    if ( typeof targetURL !== 'string' || targetURL === '' ) {
        return null;
    }

    // extension pages
    if ( /^[\w-]{2,}:/.test(targetURL) !== true ) {
        targetURL = vAPI.getURL(targetURL);
    }

    // dealing with Chrome's asynchronous API
    var wrapper = function() {
        if ( details.active === undefined ) {
            details.active = true;
        }

        var subWrapper = function() {
            var _details = {
                url: targetURL,
                active: !!details.active
            };

            // Opening a tab from incognito window won't focus the window
            // in which the tab was opened
            var focusWindow = function(tab) {
                if ( tab.active ) {
                    browser.windows.update(tab.windowId, { focused: true });
                }
            };

            if ( !details.tabId ) {
                if ( details.index !== undefined ) {
                    _details.index = details.index;
                }

                browser.tabs.create(_details, focusWindow);
                return;
            }

            // update doesn't accept index, must use move
            browser.tabs.update(toChromiumTabId(details.tabId), _details, function(tab) {
                // if the tab doesn't exist
                if ( vAPI.lastError() ) {
                    browser.tabs.create(_details, focusWindow);
                } else if ( details.index !== undefined ) {
                    browser.tabs.move(tab.id, {index: details.index});
                }
            });
        };

        // Open in a standalone window
        if ( details.popup === true ) {
            browser.windows.create({
                url: details.url,
                focused: details.active,
                type: 'popup'
            });
            return;
        }

        if ( details.index !== -1 ) {
            subWrapper();
            return;
        }

        vAPI.tabs.get(null, function(tab) {
            if ( tab ) {
                details.index = tab.index + 1;
            } else {
                delete details.index;
            }

            subWrapper();
        });
    };

    if ( !details.select ) {
        wrapper();
        return;
    }

    // https://developer.chrome.com/extensions/tabs#method-query
    // "Note that fragment identifiers are not matched."
    // It's a lie, fragment identifiers ARE matched. So we need to remove the
    // fragment.
    var pos = targetURL.indexOf('#');
    var targetURLWithoutHash = pos === -1 ? targetURL : targetURL.slice(0, pos);

    browser.tabs.query({ url: targetURLWithoutHash }, function(tabs) {
        var tab = tabs[0];
        if ( !tab ) {
            wrapper();
            return;
        }

        var _details = {
            active: true,
            url: undefined
        };
        if ( targetURL !== tab.url ) {
            _details.url = targetURL;
        }
        browser.tabs.update(tab.id, _details, function(tab) {
            browser.windows.update(tab.windowId, { focused: true });
        });
    });
};

/******************************************************************************/

// Replace the URL of a tab. Noop if the tab does not exist.

vAPI.tabs.replace = function(tabId, url) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    var targetURL = url;

    // extension pages
    if ( /^[\w-]{2,}:/.test(targetURL) !== true ) {
        targetURL = vAPI.getURL(targetURL);
    }

    browser.tabs.update(tabId, { url: targetURL }, function() {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( browser.runtime.lastError ) {
            /* noop */
        }
    });
};

/******************************************************************************/

vAPI.tabs.remove = function(tabId) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    var onTabRemoved = function() {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( browser.runtime.lastError ) {
            /* noop */
        }
    };

    browser.tabs.remove(tabId, onTabRemoved);
};

/******************************************************************************/

vAPI.tabs.reload = function(tabId /*, flags*/) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    // Workaround for Edge tab reloading
    // see: https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/tabs/reload#Browser_compatibility
    browser.tabs.get(tabId, function(tab){
        if (browser.tabs.lastError || !tab) {
            /* noop */
            return;
        }
        vAPI.tabs.replace(tabId, tab.url);
    });
};

/******************************************************************************/

// Select a specific tab.

vAPI.tabs.select = function(tabId) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    browser.tabs.update(tabId, { active: true }, function(tab) {
        if ( browser.runtime.lastError ) {
            /* noop */
        }
        if ( !tab ) {
            return;
        }
        browser.windows.update(tab.windowId, { focused: true });
    });
};

/******************************************************************************/

vAPI.tabs.injectScript = function(tabId, details, callback) {
    var onScriptExecuted = function() {
        // https://code.google.com/p/chromium/issues/detail?id=410868#c8
        if ( browser.runtime.lastError ) {
            /* noop */
        }
        if ( typeof callback === 'function' ) {
            callback();
        }
    };
    if ( tabId ) {
        browser.tabs.executeScript(toChromiumTabId(tabId), details, onScriptExecuted);
    } else {
        browser.tabs.executeScript(details, onScriptExecuted);
    }
};

/******************************************************************************/
/******************************************************************************/

// Must read: https://code.google.com/p/chromium/issues/detail?id=410868#c8

// https://github.com/chrisaljoudi/uBlock/issues/19
// https://github.com/chrisaljoudi/uBlock/issues/207
// Since we may be called asynchronously, the tab id may not exist
// anymore, so this ensures it does still exist.

vAPI.setIcon = function(tabId, iconStatus, badge) {
    tabId = toChromiumTabId(tabId);
    if ( tabId === 0 ) {
        return;
    }

    var onIconReady = function() {
        if ( vAPI.lastError() ) {
            return;
        }
        browser.browserAction.setBadgeText({ tabId: tabId, text: badge });
        if ( badge !== '' ) {
            browser.browserAction.setBadgeBackgroundColor({
                tabId: tabId,
                color: '#666'
            });
        }
    };

    var iconPaths = iconStatus === 'on' ?
        { '19': 'img/browsericons/icon19.png',     '38': 'img/browsericons/icon38.png' } :
        { '19': 'img/browsericons/icon19-off.png', '38': 'img/browsericons/icon38-off.png' };

    browser.browserAction.setIcon({ tabId: tabId, path: iconPaths }, onIconReady);
    vAPI.contextMenu.onMustUpdate(tabId);
};

/******************************************************************************/
/******************************************************************************/

vAPI.messaging = {
    ports: {},
    listeners: {},
    defaultHandler: null,
    NOOPFUNC: noopFunc,
    UNHANDLED: 'vAPI.messaging.notHandled'
};

/******************************************************************************/

vAPI.messaging.listen = function(listenerName, callback) {
    this.listeners[listenerName] = callback;
};

/******************************************************************************/

vAPI.messaging.onPortMessage = (function() {
    var messaging = vAPI.messaging;
    var toAuxPending = {};

    // Use a wrapper to avoid closure and to allow reuse.
    var CallbackWrapper = function(port, request, timeout) {
        this.callback = this.proxy.bind(this); // bind once
        this.init(port, request, timeout);
    };

    CallbackWrapper.prototype.init = function(port, request, timeout) {
        this.port = port;
        this.request = request;
        this.timerId = timeout !== undefined ?
                            vAPI.setTimeout(this.callback, timeout) :
                            null;
        return this;
    };

    CallbackWrapper.prototype.proxy = function(response) {
        if ( this.timerId !== null ) {
            clearTimeout(this.timerId);
            delete toAuxPending[this.timerId];
            this.timerId = null;
        }
        // https://github.com/chrisaljoudi/uBlock/issues/383
        if ( messaging.ports.hasOwnProperty(this.port.name) ) {
            this.port.postMessage({
                auxProcessId: this.request.auxProcessId,
                channelName: this.request.channelName,
                msg: response !== undefined ? response : null
            });
        }
        // Mark for reuse
        this.port = this.request = null;
        callbackWrapperJunkyard.push(this);
    };

    var callbackWrapperJunkyard = [];

    var callbackWrapperFactory = function(port, request, timeout) {
        var wrapper = callbackWrapperJunkyard.pop();
        if ( wrapper ) {
            return wrapper.init(port, request, timeout);
        }
        return new CallbackWrapper(port, request, timeout);
    };

    var toAux = function(details, portFrom) {
        var port, portTo;
        var chromiumTabId = toChromiumTabId(details.toTabId);

        // TODO: This could be an issue with a lot of tabs: easy to address
        //       with a port name to tab id map.
        for ( var portName in messaging.ports ) {
            if ( messaging.ports.hasOwnProperty(portName) === false ) {
                continue;
            }
            // When sending to an auxiliary process, the target is always the
            // port associated with the root frame.
            port = messaging.ports[portName];
            if ( port.sender.frameId === 0 && port.sender.tab.id === chromiumTabId ) {
                portTo = port;
                break;
            }
        }

        var wrapper;
        if ( details.auxProcessId !== undefined ) {
            wrapper = callbackWrapperFactory(portFrom, details, 1023);
        }

        // Destination not found: 
        if ( portTo === undefined ) {
            if ( wrapper !== undefined ) {
                wrapper.callback();
            }
            return;
        }

        // As per HTML5, timer id is always an integer, thus suitable to be
        // used as a key, and which value is safe to use across process
        // boundaries.
        if ( wrapper !== undefined ) {
            toAuxPending[wrapper.timerId] = wrapper;
        }

        portTo.postMessage({
            mainProcessId: wrapper && wrapper.timerId,
            channelName: details.toChannel,
            msg: details.msg
        });
    };

    var toAuxResponse = function(details) {
        var mainProcessId = details.mainProcessId;
        if ( mainProcessId === undefined ) {
            return;
        }
        if ( toAuxPending.hasOwnProperty(mainProcessId) === false ) {
            return;
        }
        var wrapper = toAuxPending[mainProcessId];
        delete toAuxPending[mainProcessId];
        wrapper.callback(details.msg);
    };

    return function(request, port) {
        // Auxiliary process to auxiliary process
        if ( request.toTabId !== undefined ) {
            toAux(request, port);
            return;
        }

        // Auxiliary process to auxiliary process: response
        if ( request.mainProcessId !== undefined ) {
            toAuxResponse(request);
            return;
        }

        // Auxiliary process to main process: prepare response
        var callback = messaging.NOOPFUNC;
        if ( request.auxProcessId !== undefined ) {
            callback = callbackWrapperFactory(port, request).callback;
        }

        // Auxiliary process to main process: specific handler
        var r = messaging.UNHANDLED;
        var listener = messaging.listeners[request.channelName];
        if ( typeof listener === 'function' ) {
            r = listener(request.msg, port.sender, callback);
        }
        if ( r !== messaging.UNHANDLED ) {
            return;
        }

        // Auxiliary process to main process: default handler
        r = messaging.defaultHandler(request.msg, port.sender, callback);
        if ( r !== messaging.UNHANDLED ) {
            return;
        }

        // Auxiliary process to main process: no handler
        console.error('uBlock> messaging > unknown request: %o', request);

        // Need to callback anyways in case caller expected an answer, or
        // else there is a memory leak on caller's side
        callback();
    };
})();

/******************************************************************************/

vAPI.messaging.onPortDisconnect = function(port) {
    port.onDisconnect.removeListener(vAPI.messaging.onPortDisconnect);
    port.onMessage.removeListener(vAPI.messaging.onPortMessage);
    delete vAPI.messaging.ports[port.name];
};

/******************************************************************************/

vAPI.messaging.onPortConnect = function(port) {
    port.onDisconnect.addListener(vAPI.messaging.onPortDisconnect);
    port.onMessage.addListener(vAPI.messaging.onPortMessage);
    vAPI.messaging.ports[port.name] = port;
};

/******************************************************************************/

vAPI.messaging.setup = function(defaultHandler) {
    // Already setup?
    if ( this.defaultHandler !== null ) {
        return;
    }

    if ( typeof defaultHandler !== 'function' ) {
        defaultHandler = function(){ return vAPI.messaging.UNHANDLED; };
    }
    this.defaultHandler = defaultHandler;

    browser.runtime.onConnect.addListener(this.onPortConnect);
};

/******************************************************************************/

vAPI.messaging.broadcast = function(message) {
    var messageWrapper = {
        broadcast: true,
        msg: message
    };

    for ( var portName in this.ports ) {
        if ( this.ports.hasOwnProperty(portName) === false ) {
            continue;
        }
        // Do not stop broadcasting upon errors,
        // workaround for Edge 'handle is invalid' error
        try {
            this.ports[portName].postMessage(messageWrapper);
        } catch(e) {
        }
    }
};

/******************************************************************************/
/******************************************************************************/

vAPI.net = {};

/******************************************************************************/

vAPI.net.registerListeners = function() {
    var µb = µBlock;
    var µburi = µb.URI;

    // https://bugs.chromium.org/p/chromium/issues/detail?id=410382
    // Between Chromium 38-48, plug-ins' network requests were reported as
    // type "other" instead of "object".
    var is_v38_48 = /\bChrom[a-z]+\/(?:3[89]|4[0-8])\.[\d.]+\b/.test(navigator.userAgent);

    // Chromium-based browsers understand only these network request types.
    var validTypes = {
        'main_frame': true,
        'sub_frame': true,
        'stylesheet': true,
        'script': true,
        'image': true,
        'object': true,
        'xmlhttprequest': true,
        'other': true
    };

    var denormalizeTypes = function(aa) {
        if ( aa.length === 0 ) {
            return Object.keys(validTypes);
        }
        var out = [];
        var i = aa.length,
            type,
            needOther = true;
        while ( i-- ) {
            type = aa[i];
            if ( validTypes.hasOwnProperty(type) ) {
                out.push(type);
            }
            if ( type === 'other' ) {
                needOther = false;
            }
        }
        if ( needOther ) {
            out.push('other');
        }
        return out;
    };

    var headerValue = function(headers, name) {
        var i = headers.length;
        while ( i-- ) {
            if ( headers[i].name.toLowerCase() === name ) {
                return headers[i].value.trim();
            }
        }
        return '';
    };

    var normalizeRequestDetails = function(details) {
        details.tabId = details.tabId.toString();

        // https://github.com/gorhill/uBlock/issues/1493
        // Chromium 49+ support a new request type: `ping`, which is fired as
        // a result of using `navigator.sendBeacon`.
        if ( details.type === 'ping' ) {
            details.type = 'beacon';
            return;
        }

        // The rest of the function code is to normalize type
        if ( details.type !== 'other' ) {
            return;
        }

        var path = µburi.pathFromURI(details.url);
        var pos = path.indexOf('.', path.length - 6);

        // https://github.com/chrisaljoudi/uBlock/issues/862
        // If no transposition possible, transpose to `object` as per
        // Chromium bug 410382 (see below)
        if ( pos !== -1 ) {
            var needle = path.slice(pos) + '.';
            if ( '.eot.ttf.otf.svg.woff.woff2.'.indexOf(needle) !== -1 ) {
                details.type = 'font';
                return;
            }

            if ( '.mp3.mp4.webm.'.indexOf(needle) !== -1 ) {
                details.type = 'media';
                return;
            }

            // Still need this because often behind-the-scene requests are wrongly
            // categorized as 'other'
            if ( '.ico.png.gif.jpg.jpeg.webp.'.indexOf(needle) !== -1 ) {
                details.type = 'image';
                return;
            }
        }

        // Try to extract type from response headers if present.
        if ( details.responseHeaders ) {
            var contentType = headerValue(details.responseHeaders, 'content-type');
            if ( contentType.startsWith('font/') ) {
                details.type = 'font';
                return;
            }
            if ( contentType.startsWith('image/') ) {
                details.type = 'image';
                return;
            }
            if ( contentType.startsWith('audio/') || contentType.startsWith('video/') ) {
                details.type = 'media';
                return;
            }
        }

        // https://code.google.com/p/chromium/issues/detail?id=410382
        if ( is_v38_48 ) {
            details.type = 'object';
        }
    };

    // https://bugs.chromium.org/p/chromium/issues/detail?id=129353
    // https://github.com/gorhill/uBlock/issues/1497
    // Expose websocket-based network requests to uBO's filtering engine,
    // logger, etc.
    // Counterpart of following block of code is found in "vapi-client.js" --
    // search for "https://github.com/gorhill/uBlock/issues/1497".
    var onBeforeWebsocketRequest = function(details) {
        details.type = 'websocket';
        var matches = /url=([^&]+)/.exec(details.url);
        details.url = decodeURIComponent(matches[1]);
        var r = onBeforeRequestClient(details);
        // Blocked?
        if ( r && r.cancel ) {
            return r;
        }
        // Returning a 1x1 transparent pixel means "not blocked".
        return { redirectUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' };
    };

    var onBeforeRequestClient = this.onBeforeRequest.callback;
    var onBeforeRequest = function(details) {
        // https://github.com/gorhill/uBlock/issues/1497
        if (
            details.type === 'image' &&
            details.url.endsWith('ubofix=f41665f3028c7fd10eecf573336216d3')
        ) {
            return onBeforeWebsocketRequest(details);
        }

        normalizeRequestDetails(details);
        return onBeforeRequestClient(details);
    };

    var onHeadersReceivedClient = this.onHeadersReceived.callback;
    var onHeadersReceivedClientTypes = this.onHeadersReceived.types.slice(0);
    var onHeadersReceivedTypes = denormalizeTypes(onHeadersReceivedClientTypes);
    var onHeadersReceived = function(details) {
        normalizeRequestDetails(details);
        // Hack to work around Chromium API limitations, where requests of
        // type `font` are returned as `other`. For example, our normalization
        // fail at transposing `other` into `font` for URLs which are outside
        // what is expected. At least when headers are received we can check
        // for content type `font/*`. Blocking at onHeadersReceived time is
        // less worse than not blocking at all. Also, due to Chromium bug,
        // `other` always becomes `object` when it can't be normalized into
        // something else. Test case for "unfriendly" font URLs:
        //   https://www.google.com/fonts
        if ( details.type === 'font' ) {
            var r = onBeforeRequestClient(details);
            if ( typeof r === 'object' && r.cancel === true ) {
                return { cancel: true };
            }
        }
        if (
            onHeadersReceivedClientTypes.length !== 0 &&
            onHeadersReceivedClientTypes.indexOf(details.type) === -1
        ) {
            return;
        }
        return onHeadersReceivedClient(details);
    };

    var installListeners = (function() {
        var listener;
        var crapi = browser.webRequest;

        listener = onBeforeRequest;
        //listener = function(details) {
        //    quickProfiler.start('onBeforeRequest');
        //    var r = onBeforeRequest(details);
        //    quickProfiler.stop();
        //    return r;
        //};
        if ( crapi.onBeforeRequest.hasListener(listener) === false ) {
            crapi.onBeforeRequest.addListener(
                listener,
                {
                    'urls': this.onBeforeRequest.urls || ['<all_urls>'],
                    'types': this.onBeforeRequest.types || undefined
                },
                this.onBeforeRequest.extra
            );
        }

        listener = onHeadersReceived;
        if ( crapi.onHeadersReceived.hasListener(listener) === false ) {
            crapi.onHeadersReceived.addListener(
                listener,
                {
                    'urls': this.onHeadersReceived.urls || ['<all_urls>'],
                    'types': onHeadersReceivedTypes
                },
                this.onHeadersReceived.extra
            );
        }

        // https://github.com/gorhill/uBlock/issues/675
        // Experimental: keep polling to be sure our listeners are still installed.
        //setTimeout(installListeners, 20000);
    }).bind(this);

    installListeners();
};

/******************************************************************************/
/******************************************************************************/

vAPI.contextMenu = {
    _callback: null,
    _entries: [],
    _createEntry: function(entry) {
        browser.contextMenus.create(JSON.parse(JSON.stringify(entry)), function() {
            void browser.runtime.lastError;
        });
    },
    onMustUpdate: function() {},
    setEntries: function(entries, callback) {
        entries = entries || [];
        var n = Math.max(this._entries.length, entries.length),
            oldEntryId, newEntry;
        for ( var i = 0; i < n; i++ ) {
            oldEntryId = this._entries[i];
            newEntry = entries[i];
            if ( oldEntryId && newEntry ) {
                if ( newEntry.id !== oldEntryId ) {
                    browser.contextMenus.remove(oldEntryId);
                    this._createEntry(newEntry);
                    this._entries[i] = newEntry.id;
                }
            } else if ( oldEntryId && !newEntry ) {
                browser.contextMenus.remove(oldEntryId);
            } else if ( !oldEntryId && newEntry ) {
                this._createEntry(newEntry);
                this._entries[i] = newEntry.id;
            }
        }
        n = this._entries.length = entries.length;
        callback = callback || null;
        if ( callback === this._callback ) {
            return;
        }
        if ( n !== 0 && callback !== null ) {
            browser.contextMenus.onClicked.addListener(callback);
            this._callback = callback;
        } else if ( n === 0 && this._callback !== null ) {
            browser.contextMenus.onClicked.removeListener(this._callback);
            this._callback = null;
        }
    }
};

/******************************************************************************/
/******************************************************************************/

vAPI.lastError = function() {
    return browser.runtime.lastError;
};

/******************************************************************************/
/******************************************************************************/

// This is called only once, when everything has been loaded in memory after
// the extension was launched. It can be used to inject content scripts
// in already opened web pages, to remove whatever nuisance could make it to
// the web pages before uBlock was ready.

vAPI.onLoadAllCompleted = function() {
    // http://code.google.com/p/chromium/issues/detail?id=410868#c11
    // Need to be sure to access `vAPI.lastError()` to prevent
    // spurious warnings in the console.
    var scriptDone = function() {
        vAPI.lastError();
    };
    var scriptStart = function(tabId) {
        vAPI.tabs.injectScript(tabId, {
            file: 'js/vapi-client.js',
            allFrames: true,
            runAt: 'document_idle'
        }, function(){ });
        vAPI.tabs.injectScript(tabId, {
            file: 'js/contentscript.js',
            allFrames: true,
            runAt: 'document_idle'
        }, scriptDone);
    };
    var bindToTabs = function(tabs) {
        var µb = µBlock;
        var i = tabs.length, tab;
        while ( i-- ) {
            tab = tabs[i];
            µb.tabContextManager.commit(tab.id, tab.url);
            µb.bindTabToPageStats(tab.id);
            // https://github.com/chrisaljoudi/uBlock/issues/129
            scriptStart(tab.id);
        }
    };

    browser.tabs.query({ url: '<all_urls>' }, bindToTabs);
};

/******************************************************************************/
/******************************************************************************/

vAPI.punycodeHostname = function(hostname) {
    return hostname;
};

vAPI.punycodeURL = function(url) {
    return url;
};

/******************************************************************************/
/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/531
// Storage area dedicated to admin settings. Read-only.

// https://github.com/gorhill/uBlock/commit/43a5ed735b95a575a9339b6e71a1fcb27a99663b#commitcomment-13965030
// Not all Chromium-based browsers support managed storage. Merely testing or
// exception handling in this case does NOT work: I don't know why. The
// extension on Opera ends up in a non-sensical state, whereas vAPI become
// undefined out of nowhere. So only solution left is to test explicitly for
// Opera.
// https://github.com/gorhill/uBlock/issues/900
// Also, UC Browser: http://www.upsieutoc.com/image/WXuH

vAPI.adminStorage = {
    getItem: function(key, callback) {
        var onRead = function(store) {
            var data;
            if (
                !browser.runtime.lastError &&
                typeof store === 'object' &&
                store !== null
            ) {
                data = store[key];
            }
            callback(data);
        };
        try {
            browser.storage.managed.get(key, onRead);
        } catch (ex) {
            callback();
        }
    }
};

/******************************************************************************/
/******************************************************************************/

vAPI.cloud = (function() {
    var noop = function() {};
    return {
        start: noop,
        push: noop,
        pull: noop,
        getOptions: noop,
        setOptions: noop,
        isSupported: false
    };
})();

/******************************************************************************/
/******************************************************************************/

})();

/******************************************************************************/
