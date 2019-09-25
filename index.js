const request = require('request')
const aesjs = require('aes-js')

if (typeof window === "undefined") {
  var window = {}
}

if (typeof window.crypto === "undefined") {
  const WebCrypto = require("node-webcrypto-ossl");
  var crypto = new WebCrypto();
} else {
  var crypto = window.crypto;
}

const config = {
  api: {
    base_url: "https://api.evervault.com"
  },
  crypto: {
    algorithm: {
      name: "ECDH",
      namedCurve: "P-256"
    },
    allowed: ["deriveKey", "deriveBits"]
  }
}

const utils = {
  get: function (path, callback) {
    request({
      url: (path.substr(0,8) === "https://" || path.substr(0,7) === "http://" ? path : config.api.base_url + path),
      method: "GET",
      headers: {
        Authorization: "Bearer " + config.api.token
      }
    }, callback)
  },

  post: function (path, body, callback) {
    request({
      url: (path.substr(0,8) === "https://" || path.substr(0,7) === "http://" ? path : config.api.base_url + path),
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.api.token
      },
      json: body
    }, callback)
  },

  loadKey: function (enclave, this_keystring, callback) {
    crypto.subtle.importKey(
      "spki",
      Buffer.from(this_keystring, "hex"),
      config.crypto.algorithm,
      true,
      []
    ).then(enclave_key => {
      callback(enclave, enclave_key)
    })
  }
}

const evervault = {
  cages: {
    list: function (callback) {
      utils.get("/cages", function (err, head, body) {
          callback(err, body)
      })
    },

    deploy: function (func, callback) {
      let source = "(" + func.toString() + ")()"

      utils.post("/cages", {
        source: source,
        metadata: {
          framework: "node.js",
          version: process.version
        }
      }, function (err, head, body) {
        callback(err, body)
      })
    }
  },


  data: {
    encrypt: function (cages, data, callback) {
      // first, retrieve the key for each of the cages
      const result = {}
      const keys = {}

      let keys_received = 0
      let keys_to_receive = cages.length

      let result_string = ["enc"]

      crypto.subtle.generateKey(
        config.crypto.algorithm,
        true,
        config.crypto.allowed
      ).then(function(key) {
        crypto.subtle.exportKey("spki", key.publicKey).then(publicKey => {
          // okay, we've got a temporary public key for the SDK. now load all of the public keys for the enclave
          utils.get("https://ev.run/keys/" + cages.join(","), function (err, head, body) {
            let enclave_keystrings = JSON.parse(body)
            let enclave_keys = {}

            let enclave_keys_loaded = 0

            for (var enclave in enclave_keystrings) {
              let this_keystring = enclave_keystrings[enclave]

              utils.loadKey(enclave, this_keystring, function (enclave, enclave_key) {
                enclave_keys[enclave] = enclave_key
                enclave_keys_loaded++

                if (enclave_keys_loaded == cages.length) {
                  // okay all the enclave keys are loaded
                  // now loop through the entire object and encrypt the fields
                  let returnObj = {}

                  let to_encrypt = Object.keys(data).length * Object.keys(cages).length
                  let encrypted = 0

                  for (var item in data) {
                    let this_item = data[item]
                    let this_string = []

                    returnObj[Object.keys(data)[Object.values(data).indexOf(this_item)]] = ["enc", Buffer.from(publicKey).toString("hex")]

                    Object.keys(enclave_keys).forEach(function (enclave_key) {
                      let this_enclave_key = enclave_keys[enclave_key]

                      crypto.subtle.deriveBits(
                        {
                          name: "ECDH",
                          public: this_enclave_key
                        },
                        key.privateKey,
                        256
                      ).then(derived => {
                        // we're not re-using keys, so using a counter of 0 is okay
                        var aesCtr = new aesjs.ModeOfOperation.ctr(new Uint8Array(derived), new aesjs.Counter(0))
                        returnObj[Object.keys(data)[Object.values(data).indexOf(this_item)]].push([enclave_key, aesjs.utils.hex.fromBytes(aesCtr.encrypt(aesjs.utils.utf8.toBytes(this_item)))].join("/"))
                        encrypted++

                        if (encrypted === to_encrypt) {
                          for (var param in returnObj) {
                            returnObj[param] = returnObj[param].join(":")
                          }
                          callback(false, returnObj)
                        }
                      })
                    })
                  }
                }
              })
            }
          })
        })
      })
    }
  }
}

module.exports = function (apiToken) {
  config.api.token = apiToken

  utils.get("/users/me", function (err, head, body) {
    if (err) throw err
    if (!JSON.parse(body).email) throw new Error("evervault Authentication Failed")
  })

  return evervault
}
