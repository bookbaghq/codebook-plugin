// The native operator's per-clone Ed25519 key. All public output is device material only.
import Foundation
import CryptoKit
import Security
import LocalAuthentication

let args = Array(CommandLine.arguments.dropFirst())
func refuse() -> Never { exit(1) }
guard args.count >= 2, args[1].range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { refuse() }
let service = "work.codebook.local-git.device.v1"
let account = args[1]
let context = LAContext()
context.interactionNotAllowed = true
let lookup: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
    kSecUseAuthenticationContext: context
]
func existing() -> (OSStatus, Data?) {
    var query = lookup
    query[kSecReturnData] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    return (status, item as? Data)
}
func report(_ key: Curve25519.Signing.PrivateKey) throws {
    let raw = key.publicKey.rawRepresentation
    if args[0] == "sign" {
        guard args.count == 3, raw.base64EncodedString() == args[2] else { refuse() }
        let message = FileHandle.standardInput.readDataToEndOfFile()
        guard message.count <= 16384 else { refuse() }
        print(try key.signature(for: message).base64EncodedString())
    } else if args[0] == "public" || args[0] == "enroll" {
        print(raw.base64EncodedString())
    } else { refuse() }
}
do {
    var (status, data) = existing()
    if status == errSecItemNotFound && args[0] == "enroll" {
        let key = Curve25519.Signing.PrivateKey()
        var entry = lookup
        entry[kSecAttrSynchronizable] = false
        entry[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        entry[kSecValueData] = key.rawRepresentation
        let inserted = SecItemAdd(entry as CFDictionary, nil)
        guard inserted == errSecSuccess || inserted == errSecDuplicateItem else { refuse() }
        (status, data) = existing()
    }
    guard status == errSecSuccess, let raw = data else { refuse() }
    try report(Curve25519.Signing.PrivateKey(rawRepresentation: raw))
} catch { refuse() }
