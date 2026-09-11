#!/bin/sh
# The stock contacts picker shows a contact's detail card on tap instead of selecting it.
# Tell CNContactPickerViewController explicitly that tapping a contact selects it.
F=node_modules/@capacitor-community/contacts/ios/Sources/ContactsPlugin/ContactsPlugin.swift
grep -q "predicateForSelectionOfContact" "$F" && exit 0
sed -i '' 's|                contactPicker.delegate = self|                contactPicker.delegate = self\n                contactPicker.predicateForSelectionOfContact = NSPredicate(value: true)\n                contactPicker.predicateForEnablingContact = NSPredicate(value: true)|' "$F"
grep -q "predicateForSelectionOfContact" "$F" && echo "contacts picker patched"
