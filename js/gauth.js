// A simple authentication application written in HTML
// Copyright (C) 2012 Gerard Braad
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

(function(exports) {
    "use strict";

    var StorageService = function() {
        var setObject = function(key, value) {
            localStorage.setItem(key, JSON.stringify(value));
        };

        var getObject = function(key) {
            var value = localStorage.getItem(key);
            // if(value) return parsed JSON else undefined
            return value && JSON.parse(value);
        };

        var isSupported = function() {
            return typeof (Storage) !== "undefined";
        };

        // exposed functions
        return {
            isSupported: isSupported,
            getObject: getObject,
            setObject: setObject
        };
    };

    exports.StorageService = StorageService;

    // Originally based on the JavaScript implementation as provided by Russell Sayers on his Tin Isles blog:
    // http://blog.tinisles.com/2011/10/google-authenticator-one-time-password-algorithm-in-javascript/

    var KeyUtilities = function(jsSHA) {

        var dec2hex = function(s) {
            return (s < 15.5 ? '0' : '') + Math.round(s).toString(16);
        };

        var hex2dec = function(s) {
            return parseInt(s, 16);
        };

        var base32tohex = function(base32) {
            var base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
            var bits = "";
            var hex = "";

            for (var i = 0; i < base32.length; i++) {
                var val = base32chars.indexOf(base32.charAt(i).toUpperCase());
                bits += leftpad(val.toString(2), 5, '0');
            }

            for (i = 0; i + 4 <= bits.length; i += 4) {
                var chunk = bits.substr(i, 4);
                hex = hex + parseInt(chunk, 2).toString(16);
            }

            return hex;
        };

        var leftpad = function(str, len, pad) {
            if (len + 1 >= str.length) {
                str = new Array(len + 1 - str.length).join(pad) + str;
            }
            return str;
        };

        var generate = function(secret, epoch) {
            var key = base32tohex(secret);

            // HMAC generator requires secret key to have even number of nibbles
            if (key.length % 2 !== 0) {
                key += '0';
            }

            // If no time is given, set time as now
            if(typeof epoch === 'undefined') {
                epoch = Math.round(new Date().getTime() / 1000.0);
            }
            var time = leftpad(dec2hex(Math.floor(epoch / 30)), 16, '0');

            // external library for SHA functionality
            var hmacObj = new jsSHA(time, "HEX");
            var hmac = hmacObj.getHMAC(key, "HEX", "SHA-1", "HEX");

            var offset = 0;
            if (hmac !== 'KEY MUST BE IN BYTE INCREMENTS') {
                offset = hex2dec(hmac.substring(hmac.length - 1));
            }

            var otp = (hex2dec(hmac.substr(offset * 2, 8)) & hex2dec('7fffffff')) + '';
            return (otp).substr(otp.length - 6, 6).toString();
        };

        // exposed functions
        return {
            generate: generate
        };
    };

    exports.KeyUtilities = KeyUtilities;

    // ----------------------------------------------------------------------------
    var KeysController = function() {
        var editingEnabled = false;
        var refreshEnabled = false;
        var timerHandle = null;

        var connect = function () {
            if(timerHandle !== null)
                clearInterval(timerHandle);
            timerHandle = null;
            HWTokenManager.connect().then(async () => {
                if (HWTokenManager.connected()) {
                    await updateKeys();
                    timerHandle = setInterval(timerTick, 1000);
                    refreshEnabled = true;
                } else {
                    $('#updatingIn').text("x");
                    var $orig = $('#headerContent').hide();
                    var $hint = $('<span>No Canokey <a href="#" style="color: inherit;">Click to connect</a></span>').insertAfter($orig);
                    $hint.click(function (E) {
                        E.preventDefault();
                        $orig.show();
                        $hint.remove();
                        connect();
                    });
                }
            });
        };

        var init = function() {

            connect();

            // Bind to keypress event for the input
            $('#addKeyButton').click(function() {
                var name = $('#keyAccount').val();
                var secret = $('#keySecret').val();
                // remove spaces from secret
                secret = secret.replace(/ /g, '');
                if(secret !== '') {
                    addAccount(name, secret, $('#keyTypeTOTP').is(':checked'));
                    clearAddFields();
                    $.mobile.navigate('#main');
                } else {
                    //$('#keyAccount').val('test name');
                    //$('#keySecret').val('JBSWY3DPEHPK3PXP');
                    $('#keySecret').focus();
                }
            });

            $('#addKeyCancel').click(function() {
                clearAddFields();
            });

            var clearAddFields = function() {
                $('#keyAccount').val('');
                $('#keySecret').val('');
            };

            $('#edit').click(function() { toggleEdit(); });
        };

        var calculateSingleEntry = async ($entry, account) => {
            await account.generate();
            $entry.children('h3').html(account.code);
        };

        var updateKeys = async () => {
            console.log('updateK')
            var accountList = $('#accounts');
            var uiEntries = accountList.find("li:gt(0)");

            var entries = await HWTokenManager.get();
            console.log('entries', entries);
            var appending = false;
            var item = uiEntries.eq(0);
            if(uiEntries.length != entries.length) {
                appending = true;
                uiEntries.remove();
            }
            for (const account of entries) {
                // generate TOTP only
                await account.next();

                if (!appending && item.children('p:eq(0)').text() === account.issuer) {
                    item.children('h3').html(account.code);
                    item = item.next();
                    continue;
                }

                // Construct HTML
                var detLink = $('<h3>' + account.code + '</h3><p></p>');
                var accElem = $('<li data-icon="false">').append(detLink);
                accElem.find('p').text(account.issuer);
                accElem.click(function () {
                    calculateSingleEntry($(this), account);
                    return true;
                });

                var delLink = $('<p class="ui-li-aside delete-entry"><a class="ui-btn-icon-notext ui-icon-delete" href="#"></a></p>');
                delLink.click(function () {
                    deleteAccount(account);
                    return true;
                });
                accElem.append(delLink);

                if (appending) {
                    // Add HTML element
                    accountList.append(accElem);
                } else {
                    var cur = item;
                    item = item.next();
                    cur.replaceWith(accElem);
                }
            }

            accountList.listview().listview('refresh');

            if(!HWTokenManager.connected())
                connect();
        };

        var toggleEdit = function() {
            editingEnabled = !editingEnabled;
            if(editingEnabled) {
                $('#addButton').show();
                $('.delete-entry').show();
            } else {
                $('#addButton').hide();
                $('.delete-entry').hide();
            }
        };

        var deleteAccount = function (account) {
            refreshEnabled = false;
            HWTokenManager.delete(account).then(async () => {
                await updateKeys();
                refreshEnabled = true;
            });
        };

        var addAccount = function(name, secret, isTOTP) {
            if(secret === '') {
                // Bailout
                return false;
            }

            // Construct JSON object
            var account = new OTPEntry({
                'index': 0,
                'issuer': name,
                'type': isTOTP ? 1 : 2,
                'algorithm': 1,
                'secret': secret
            });

            refreshEnabled = false;
            HWTokenManager.add(account).then(async ()=>{
                await updateKeys();
                refreshEnabled = true;
            });

            return true;
        };

        var timerTick = function() {
            var epoch = Math.round(new Date().getTime() / 1000.0);
            var countDown = 30 - (epoch % 30);
            if (epoch % 30 === 0 && refreshEnabled) {
                updateKeys();
            }
            $('#updatingIn').text(countDown);
        };

        return {
            init: init,
            addAccount: addAccount,
            deleteAccount: deleteAccount
        };
    };

    exports.KeysController = KeysController;

})(typeof exports === 'undefined' ? this['gauth']={} : exports);
