#!/bin/sh
# The stock contacts picker shows a contact's detail card on tap instead of selecting it.
# Tell CNContactPickerViewController explicitly that tapping a contact selects it.
F=node_modules/@capacitor-community/contacts/ios/Sources/ContactsPlugin/ContactsPlugin.swift
if ! grep -q "predicateForSelectionOfContact" "$F"; then
  sed -i '' 's|                contactPicker.delegate = self|                contactPicker.delegate = self\n                contactPicker.predicateForSelectionOfContact = NSPredicate(value: true)\n                contactPicker.predicateForEnablingContact = NSPredicate(value: true)|' "$F"
  grep -q "predicateForSelectionOfContact" "$F" && echo "contacts picker patched"
fi

# contactPicker(_:didSelect:) hands back whatever key set CNContactPickerViewController
# happened to prefetch for its own list UI, which reliably includes phone numbers but not
# name fields -- so name/given/family come back empty and the caller's `name: true`
# projection is silently ignored, even though phones always work. Re-fetch the selected
# contact by identifier with the keys the caller actually asked for before filling data.
if ! grep -q "unifiedContact(withIdentifier: selectedContact.identifier" "$F"; then
  python3 - "$F" <<'PYEOF'
import sys
f = sys.argv[1]
s = open(f).read()
old = """        let contact = ContactPayload(selectedContact.identifier)

        contact.fillData(selectedContact)"""
new = """        let projectionInput = GetContactsProjectionInput(call.getObject("projection") ?? JSObject())
        let keysToFetch = projectionInput.getProjection()

        let contact = ContactPayload(selectedContact.identifier)

        // Re-fetch with the requested keys -- the picker's own CNContact rarely has
        // name fields prefetched, so filling from it directly leaves name empty.
        if let refetched = try? CNContactStore().unifiedContact(withIdentifier: selectedContact.identifier, keysToFetch: keysToFetch) {
            contact.fillData(refetched)
        } else {
            contact.fillData(selectedContact)
        }"""
assert old in s, "pickContact anchor not found -- plugin source may have changed"
s = s.replace(old, new, 1)
open(f, "w").write(s)
print("contacts picker name-refetch patched")
PYEOF
fi

# Multi-select: Apple's picker shows checkmarks and a Done button only when its delegate implements
# contactPicker(_:didSelect contacts: [CNContact]). Add a separate pickContacts method with its own
# delegate object, so the existing one-at-a-time pickContact keeps working exactly as before.
if ! grep -q "MultiContactPickDelegate" "$F"; then
  python3 - "$F" <<'PYEOF'
import sys
f = sys.argv[1]
s = open(f).read()
reg_old = '''        CAPPluginMethod(name: "pickContact", returnType: CAPPluginReturnPromise)'''
assert reg_old in s, "method registry anchor not found"
s = s.replace(reg_old, reg_old + ''',
        CAPPluginMethod(name: "pickContacts", returnType: CAPPluginReturnPromise)''', 1)
var_old = '''    private var pickContactCallbackId: String?'''
assert var_old in s, "callback id anchor not found"
s = s.replace(var_old, var_old + '''
    private var multiPickDelegate: MultiContactPickDelegate?''', 1)
fn_old = '''    @objc func pickContact(_ call: CAPPluginCall) {'''
assert fn_old in s, "pickContact anchor not found"
s = s.replace(fn_old, '''    // Pick several contacts in one pass (checkmarks + Done). Resolves { contacts: [...] }; [] if cancelled.
    @objc func pickContacts(_ call: CAPPluginCall) {
        CNContactStore().requestAccess(for: .contacts) { _, _ in
            DispatchQueue.main.async {
                let picker = CNContactPickerViewController()
                let delegate = MultiContactPickDelegate(call: call) { [weak self] in self?.multiPickDelegate = nil }
                self.multiPickDelegate = delegate
                picker.delegate = delegate
                picker.predicateForEnablingContact = NSPredicate(value: true)
                self.bridge?.viewController?.present(picker, animated: true)
            }
        }
    }

''' + fn_old, 1)
s = s.rstrip() + '''

class MultiContactPickDelegate: NSObject, CNContactPickerDelegate {
    private let call: CAPPluginCall
    private let done: () -> Void
    init(call: CAPPluginCall, done: @escaping () -> Void) { self.call = call; self.done = done }

    func contactPicker(_ picker: CNContactPickerViewController, didSelect contacts: [CNContact]) {
        let projectionInput = GetContactsProjectionInput(call.getObject("projection") ?? JSObject())
        let keysToFetch = projectionInput.getProjection()
        let store = CNContactStore()
        var out: [JSObject] = []
        for picked in contacts {
            let payload = ContactPayload(picked.identifier)
            // same name re-fetch as pickContact: the picker's CNContact rarely has name keys loaded
            if let refetched = try? store.unifiedContact(withIdentifier: picked.identifier, keysToFetch: keysToFetch) {
                payload.fillData(refetched)
            } else {
                payload.fillData(picked)
            }
            out.append(payload.getJSObject())
        }
        call.resolve(["contacts": out])
        done()
    }

    func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        call.resolve(["contacts": []])
        done()
    }
}
'''
open(f, "w").write(s)
print("contacts picker multi-select patched")
PYEOF
fi
