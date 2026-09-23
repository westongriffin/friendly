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
