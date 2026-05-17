export const MOCK_DBUS_MENU_LAYOUT = [
    0,
    {
        label: 'Root',
    },
    [
        [1, { label: '_File', enabled: true }, [
            [10, { label: '_New', enabled: true }, []],
            [11, { label: '_Open…', enabled: true }, []],
            [12, { type: 'separator' }, []],
            [13, { label: '_Quit', enabled: true }, []],
        ]],
        [2, { label: '_Edit', enabled: true }, [
            [20, { label: '_Undo', enabled: false }, []],
            [21, { label: '_Redo', enabled: false }, []],
        ]],
    ],
];
